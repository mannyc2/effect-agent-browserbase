// The protocol budget of each hot-path operation, counted at zero latency through a proxy on a
// browser reached over CDP, in the default context without a viewport that a hosted session gives.
// A refactor or a Playwright upgrade that adds a call or a round trip to one of these operations
// fails here; the counts, not the timings, are the contract.
import { assert, it } from "@effect/vitest";
import { Effect, Option, Schedule, Stream, Tracer } from "effect";

import * as Cdp from "../src/Cdp.ts";
import type { Page } from "../src/Page.ts";
import { behindProxy, type Command, type Proxy } from "./protocol.ts";

// The commands an operation sends. Screencast acknowledgements answer frames, not the operation.
const sentBy = <A, E, R>(proxy: Proxy, operation: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const before = proxy.commands.length;

    yield* operation;

    return proxy.commands
      .slice(before)
      .filter((command) => command.method !== "Page.screencastFrameAck");
  });

// An operation's calls, and the round trips they take: commands sent together share one. Only the
// registration uploads a script, the library's own page script (74 KB) once per page session; no
// other command carries it or Playwright's 335 KB injected script. A failure prints what was sent.
const holds = (commands: ReadonlyArray<Command>, calls: number, rounds: number, uploads = 0) => {
  const sent = commands.map((command) => `${command.method} (${command.bytes} B)`).join(", ");

  assert.strictEqual(commands.length, calls, sent);
  assert.strictEqual(new Set(commands.map((command) => command.round)).size, rounds, sent);
  assert.strictEqual(commands.filter((command) => command.bytes >= 2_000).length, uploads, sent);
};

const html = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

const still = (title: string) =>
  html(
    `<title>${title}</title><body style="margin:0"><h1>${title}</h1><p>A still page.</p></body>`,
  );

const animated = html(`<body style="margin:0"><canvas id=c width=300 height=300></canvas><script>
  const g = c.getContext("2d");
  (function draw(t) { g.fillStyle = "hsl(" + (t / 5 % 360) + ",80%,50%)"; g.fillRect(0, 0, 300, 300); requestAnimationFrame(draw); })(0);
</script></body>`);

const opened = (args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy(args);
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });

    return { proxy, browser };
  });

const framesArrive = (page: Page) =>
  page.latestFrame.pipe(
    Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Option.isSome }),
    Effect.timeout("10 seconds"),
  );

it.live("a picture of a changing page with its screencast running costs no call", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(animated);

    yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
    yield* framesArrive(page);

    holds(yield* sentBy(proxy, page.screenshot({ maxAge: "1 second" })), 0, 0);
    holds(yield* sentBy(proxy, page.frame({ maxAge: "1 second" })), 0, 0);
  }).pipe(Effect.scoped),
);

it.live("a picture of a still page costs one call, on a new document too", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("one"));

    // The page's first picture also learns the viewport, which Playwright does not know over CDP.
    holds(yield* sentBy(proxy, page.screenshot({ maxAge: 0 })), 2, 2);

    yield* page.goto(still("two"));
    holds(yield* sentBy(proxy, page.screenshot({ maxAge: 0 })), 1, 1);
    holds(yield* sentBy(proxy, page.frame({ maxAge: 0 })), 1, 1);
  }).pipe(Effect.scoped),
);

it.live("a crop costs two calls", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("crop"));

    yield* page.screenshot({ maxAge: 0 });
    holds(yield* sentBy(proxy, page.zoom({ x: 10, y: 10, width: 120, height: 90 })), 2, 2);
  }).pipe(Effect.scoped),
);

it.live("a picture at another device pixel ratio costs two calls", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened(["--force-device-scale-factor=2"]);
    const page = yield* browser.newPage(still("dense"));

    // The first picture learns the ratio and the viewport.
    yield* page.screenshot({ maxAge: 0 });
    holds(yield* sentBy(proxy, page.screenshot({ maxAge: 0 })), 2, 2);
    const viewport = yield* page.viewport;
    const image = yield* page.screenshot({ maxAge: 0 });

    assert.deepStrictEqual([image.width, image.height], [viewport.width, viewport.height]);
  }).pipe(Effect.scoped),
);

it.live("a read costs two calls on a new document, and one warm", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("one"));

    // The first read registers the page script with the page's own session, once: three calls
    // sent together, then the world and the read.
    holds(yield* sentBy(proxy, page.snapshot()), 5, 3, 1);

    yield* page.goto(still("two"));
    holds(yield* sentBy(proxy, page.snapshot()), 2, 2);
    holds(yield* sentBy(proxy, page.snapshot()), 1, 1);
    holds(yield* sentBy(proxy, page.find({ role: "heading" })), 1, 1);
    holds(yield* sentBy(proxy, page.text()), 1, 1);
    assert.include((yield* page.text()).text, "two");
  }).pipe(Effect.scoped),
);

// The library counts each operation's calls into its span; the proxy sees the same calls on the
// wire, where each message also carries its envelope: an id, a method and a session.
it.live("a page operation's span reports the calls and bytes the wire carried", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("spans"));
    const spans: Array<Tracer.NativeSpan> = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    yield* page.screenshot({ maxAge: 0 });
    yield* page.snapshot();
    for (const [name, operation] of [
      ["Page.screenshot", Effect.asVoid(page.screenshot({ maxAge: 0 }))],
      ["Page.snapshot", Effect.asVoid(page.snapshot())],
      ["Page.zoom", Effect.asVoid(page.zoom({ x: 0, y: 0, width: 200, height: 100 }))],
    ] as const) {
      const sent = yield* sentBy(proxy, Effect.provideService(operation, Tracer.Tracer, tracer));
      const span = spans.findLast((recorded) => recorded.name === name);
      const attribute = (key: string) => Number(span?.attributes.get(key));
      const bytesOut = sent.reduce((total, command) => total + command.bytes, 0);

      const bytesIn = sent.reduce(
        (total, command) => total + (proxy.answers.get(command.id) ?? 0),
        0,
      );

      assert.strictEqual(attribute("calls"), sent.length, name);
      assert.isAtMost(attribute("bytesOut"), bytesOut, name);
      assert.isAbove(attribute("bytesOut"), bytesOut - 150 * sent.length, name);
      assert.isAtMost(attribute("bytesIn"), bytesIn, name);
      assert.isAbove(attribute("bytesIn"), bytesIn - 150 * sent.length, name);
      assert.isAbove(attribute("waitedMillis"), 0, name);
    }
    assert.strictEqual(
      spans.findLast((recorded) => recorded.name === "Page.screenshot")?.attributes.get("source"),
      "screenshot",
    );
  }).pipe(Effect.scoped),
);
