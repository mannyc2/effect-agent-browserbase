// The protocol budget of each hot-path operation, counted at zero latency through a proxy on a
// browser reached over CDP, in the default context without a viewport that a hosted session gives.
// A refactor or a Playwright upgrade that adds a call or a round trip to one of these operations
// fails here; the counts, not the timings, are the contract.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Schedule, Stream, Tracer } from "effect";

import * as Cdp from "../src/Cdp.ts";
import * as Moment from "../src/Moment.ts";
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

// The commands from a capture's start to its first frame. The frame's acknowledgement answers it.
const toFirstFrame = (proxy: Proxy, page: Page) =>
  Effect.gen(function* () {
    const before = proxy.commands.length;
    let first = before;

    yield* page.screencast().pipe(
      Stream.take(1),
      Stream.tap(() =>
        Effect.sync(() => {
          first = proxy.commands.length;
        }),
      ),
      Stream.runDrain,
    );

    return proxy.commands
      .slice(before, first)
      .filter((command) => command.method !== "Page.screencastFrameAck");
  });

const framesArrive = (page: Page) =>
  page.state.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: (state) => state.frame !== undefined,
    }),
    Effect.timeout("10 seconds"),
  );

// Playwright's own connection to the browser and its tab, and the library's session on that tab:
// attached, then in one round trip the tab's target id, which names it, focus emulation and the
// Page domain, which report its documents. Nothing is measured: no page of the library's own
// opens. How many round trips Playwright's commands share depends on how soon Chromium answers
// each, so only its calls are held. Playwright detaches from the three targets it does not track
// whenever it gets to them, before `open` returns or, on a loaded machine, after, so those
// detaches are not counted.
it.live("opening a browser over CDP costs 33 calls, the tab's registration one round trip", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    const sent = (yield* sentBy(proxy, Cdp.open({ endpoint: proxy.endpoint }))).filter(
      (command) => command.method !== "Target.detachFromTarget",
    );

    assert.strictEqual(sent.length, 33, sent.map((command) => command.method).join(", "));
    holds(
      sent.filter((command) => proxy.attached.has(command.sessionId ?? "")),
      3,
      1,
    );
  }).pipe(Effect.scoped),
);

it.live("a capture starts in two calls once the browser's clock is mapped", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("first"));

    // The browser's first capture maps its clock first, in a world of its own: that world and
    // three probes. The page script is registered to read the viewport.
    holds(yield* toFirstFrame(proxy, page), 8, 8, 1);
    // Then a capture reads the viewport and starts.
    holds(yield* toFirstFrame(proxy, page), 2, 2);
    const other = yield* browser.newPage(still("second"));

    yield* other.snapshot();
    holds(yield* toFirstFrame(proxy, other), 2, 2);
  }).pipe(Effect.scoped),
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

// A crop is the layout metrics, then the clipped picture. A page's first also reads the screen the
// page reads, beside the metrics, and holds a copy of it on the page's own session before the
// picture, so that the crop leaves the screen another session emulates as it was.
it.live("a crop costs two calls, and a page's first two more to hold its screen", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("crop"));

    yield* page.screenshot({ maxAge: 0 });
    yield* page.snapshot();
    holds(yield* sentBy(proxy, page.zoom({ x: 10, y: 10, width: 120, height: 90 })), 4, 3);
    holds(yield* sentBy(proxy, page.zoom({ x: 20, y: 10, width: 120, height: 90 })), 2, 2);
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

    // The first read registers the page script with the page's own session, once, then finds the
    // world and reads.
    holds(yield* sentBy(proxy, page.snapshot()), 3, 3, 1);

    yield* page.goto(still("two"));
    holds(yield* sentBy(proxy, page.snapshot()), 2, 2);
    holds(yield* sentBy(proxy, page.snapshot()), 1, 1);
    holds(yield* sentBy(proxy, page.find({ role: "heading" })), 1, 1);
    holds(yield* sentBy(proxy, page.find({ at: { x: 20, y: 20 } })), 1, 1);
    holds(yield* sentBy(proxy, page.text()), 1, 1);
    // A still page is ready at its first check, and one that shows something only later is
    // checked in the page until it does.
    holds(yield* sentBy(proxy, page.ready()), 1, 1);
    assert.include((yield* page.text()).text, "two");
    yield* Effect.promise(() =>
      page.playwright.evaluate(() => {
        const shown = document.body.innerHTML;

        document.body.replaceChildren();
        setTimeout(() => {
          document.body.innerHTML = shown;
        }, 300);
      }),
    );
    holds(yield* sentBy(proxy, page.ready()), 1, 1);
    // However long the page is, a read is one call.
    yield* Effect.promise(() =>
      page.playwright.evaluate(() =>
        document.body.insertAdjacentHTML("beforeend", "<p><button>Buy</button></p>".repeat(2000)),
      ),
    );
    holds(yield* sentBy(proxy, page.find({ role: "button", scope: "document" })), 1, 1);
  }).pipe(Effect.scoped),
);

// Reads asked together share the page's turn, so they go out in one round, and identical ones
// share one call and its result. The first read of changes registers the recorder and maps the
// clock, so it comes first.
it.live("identical reads asked together cost one call between them", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("joined"));

    yield* page.snapshot();
    yield* page.changes();

    const reads = Effect.all(
      [page.snapshot(), page.snapshot(), page.text(), page.text(), page.changes(), page.changes()],
      { concurrency: "unbounded" },
    );

    holds(yield* sentBy(proxy, reads), 3, 1);
  }).pipe(Effect.scoped),
);

// What the library already knows of a page costs nothing to say: no call, and no wait for the
// page's turn, so a caller that must never wait, such as an on-air read of the screen, reads it.
it.live("a page's state costs no call, nor waits for an action, and holds what the page gave", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("known"));

    yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
    yield* framesArrive(page);
    const text = yield* page.text();

    const state = yield* page.state.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: (known) => known.load?.state === "load",
      }),
      Effect.timeout("10 seconds"),
    );

    holds(yield* sentBy(proxy, page.state), 0, 0);
    assert.deepStrictEqual(
      [state.url, state.document, state.text?.title, state.text],
      [
        yield* page.url,
        (yield* page.recentEvents).findLast((event) => event._tag === "Navigated")?.document,
        "known",
        text,
      ],
    );
    assert.isDefined(state.committedAt);
    assert.isDefined(state.frame);
    // An action holding the page for two seconds holds no read of its state back.
    yield* page.press("Shift", { holdMillis: 2000 }).pipe(Effect.forkScoped);
    yield* Effect.sleep("200 millis");
    const asked = yield* browser.now;

    yield* page.state;
    assert.isBelow((yield* browser.now) - asked, 500);
    // A new document leaves behind the text read of the one before, and any load it holds is the
    // new document's.
    yield* page.goto(still("next"));
    const moved = yield* page.state;

    assert.deepStrictEqual([moved.document, moved.text], [state.document + 1, undefined]);
    assert.isAtLeast(moved.load?.at ?? Infinity, moved.committedAt ?? Infinity);
  }).pipe(Effect.scoped),
);

// A read whose caller gave up, as the consumer's did at its own 5 s limit, finishes, and the next
// caller to ask the same gets it free, until input moves the page on.
it.live(
  "a read its caller gave up costs the next caller nothing, until the page's next input",
  () =>
    Effect.gen(function* () {
      const { proxy, browser } = yield* opened();
      const page = yield* browser.newPage(still("kept"));

      // The page's own script keeps it busy for a second, so a read's caller gives up first.
      const abandoned = Effect.promise(() =>
        page.playwright.evaluate(() => {
          setTimeout(() => {
            const until = Date.now() + 1000;

            while (Date.now() < until);
          }, 0);
        }),
      ).pipe(
        Effect.andThen(page.text().pipe(Effect.timeout("100 millis"), Effect.ignore)),
        Effect.andThen(Effect.sleep("1500 millis")),
      );

      yield* page.text();
      yield* abandoned;
      holds(yield* sentBy(proxy, page.text()), 0, 0);
      yield* abandoned;
      yield* page.press("Shift");
      holds(yield* sentBy(proxy, page.text()), 1, 1);
    }).pipe(Effect.scoped),
);

// After a click that navigates nowhere, the page settles in one call: a task and a frame in the
// page, where a 120 ms sleep used to be.
it.live("waits after a click that navigates nowhere with one call", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("clicked"));

    yield* page.click({ x: 5, y: 5 });
    const sent = yield* sentBy(proxy, page.click({ x: 5, y: 5 }));
    const input = sent.findLastIndex((command) => command.method === "Input.dispatchMouseEvent");

    holds(sent.slice(input + 1), 1, 1);
  }).pipe(Effect.scoped),
);

// The change record costs a page nothing until something reads its changes: no registration, no
// call. The first read registers the recorder beside the read, in one round trip, and every later
// read is one call; a moment of a page on air adds that one call to its free picture.
it.live("a read of changes costs one call, its first a registration beside it", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(animated);

    // Registrations on the library's own session; Playwright registers scripts on its own.
    const registrations = () =>
      proxy.commands.filter(
        (command) =>
          command.method === "Page.addScriptToEvaluateOnNewDocument" &&
          proxy.attached.has(command.sessionId ?? ""),
      );

    yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
    yield* framesArrive(page);
    yield* page.snapshot();
    yield* page.ready();
    yield* page.goto(still("unread"));
    yield* page.snapshot();
    // Reads, pictures and a new document register only the page script.
    assert.strictEqual(registrations().length, 1);
    yield* page.goto(animated);
    yield* framesArrive(page);
    yield* page.snapshot();

    holds(yield* sentBy(proxy, page.changes()), 2, 1);
    assert.strictEqual(registrations().length, 2);
    holds(yield* sentBy(proxy, page.changes()), 1, 1);
    yield* Moment.capture(page);
    holds(yield* sentBy(proxy, Moment.capture(page)), 1, 1);
  }).pipe(Effect.scoped),
);

// Times of changes map through the browser's one clock mapping, which a capture measures as it
// starts. Where none has, a browser's first read of changes measures it, once: a world without the
// page script, then three probes in turn, then the registration beside the read. The next page's
// first read is those two.
it.live("a browser's first read of changes maps its clock, once, where no capture has", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const first = yield* browser.newPage(still("first"));
    const second = yield* browser.newPage(still("second"));

    yield* first.snapshot();
    yield* second.snapshot();
    holds(yield* sentBy(proxy, first.changes()), 6, 5);
    holds(yield* sentBy(proxy, second.changes()), 2, 1);
  }).pipe(Effect.scoped),
);

// A wait for a still screen asks the page before its quiet spell and once more to end it, whose
// answer comes behind any frame still on its way. With no capture running, it starts one, reading
// the viewport first, and stops it.
it.live("a wait for a still screen costs two calls, and three more without a running capture", () =>
  Effect.gen(function* () {
    const { proxy, browser } = yield* opened();
    const page = yield* browser.newPage(still("quiet"));

    yield* page.snapshot();
    // The browser's first capture maps its clock.
    yield* toFirstFrame(proxy, page);
    holds(yield* sentBy(proxy, page.ready({ quietMillis: 100 })), 5, 5);
    // A capture on air, once its first frame has come.
    const onAir = yield* Deferred.make<void>();

    yield* page.screencast().pipe(
      Stream.tap(() => Deferred.succeed(onAir, undefined)),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Deferred.await(onAir);
    holds(yield* sentBy(proxy, page.ready({ quietMillis: 100 })), 2, 2);
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
