// The accepted input-authority contract requires native drain/refusal regressions: authority
// spans every tab, records end before suspension resolves, and lost replies remain unresolved.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";

import { consequence } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import * as Stage from "../src/Stage.ts";

const document = (title = "Input") =>
  `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1><input aria-label="Memo"><button>Submit</button><select aria-label="Choice"><option>One</option><option>Two</option></select>`)}`;

const scope = Effect.gen(function* () {
  const owner = yield* Scope.make();

  yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));

  return owner;
});

// Chromium handles the command, but its acknowledgement is retained at the public native seam.
// This reproduces cancellation after dispatch without pretending a fake provider is a browser.
const delayedReply = Effect.fnUntraced(function* (page: Page, kind: "press" | "navigate") {
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const keyboard = page.playwright.keyboard;
  const down = keyboard.down.bind(keyboard);
  const goto = page.playwright.goto.bind(page.playwright);
  let sent = 0;

  const delayed = async <A>(reply: Promise<A>) => {
    sent += 1;
    const result = await reply;

    arrived.resolve();
    await release.promise;

    return result;
  };

  if (kind === "press") keyboard.down = (key) => delayed(down(key));
  else page.playwright.goto = (url, options) => delayed(goto(url, options));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      release.resolve();
      keyboard.down = down;
      page.playwright.goto = goto;
    }),
  );

  return {
    arrived: Effect.promise(() => arrived.promise),
    release: Effect.sync(() => release.resolve()),
    sent: () => sent,
  };
});

describe("Scoped browser input authority", () => {
  it.live("retains a dispatched script mutation until its actual acknowledgement arrives", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open({
        actionTimeout: "300 millis",
        navigationTimeout: "300 millis",
      });

      const create = browser.context.newCDPSession.bind(browser.context);
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let submissions = 0;

      // The beta.11 handoff requires read-only exemptions to preserve real mutation ownership.
      // Retain the reply only after Chromium has actually performed the selection.
      browser.context.newCDPSession = async (target) => {
        const cdp = await create(target);
        const send = cdp.send.bind(cdp);

        cdp.send = async (method, params) => {
          const reply = await send(method, params);

          if (
            method === "Runtime.evaluate" &&
            params !== undefined &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes("globalThis.__effectBrowser.select(")
          ) {
            submissions += 1;
            arrived.resolve();
            await release.promise;
          }

          return reply;
        };

        return cdp;
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          release.resolve();
          browser.context.newCDPSession = create;
        }),
      );
      const page = yield* browser.newPage(document());
      const other = yield* browser.newPage(document("Other"));
      const [choice] = yield* page.find({ role: "combobox", name: "Choice" });
      const stage = yield* Stage.make();

      yield* stage.present(page);
      const cue = yield* stage.cue(other);

      yield* cue.ready;

      const selecting = yield* page
        .select(choice?.ref ?? "", ["Two"])
        .pipe(Effect.flip, Effect.forkChild);

      yield* Effect.promise(() => arrived.promise);
      const failure = yield* Fiber.join(selecting);

      assert.strictEqual(failure.reason._tag, "Timeout");
      assert.isTrue(failure.dispatched);

      const suspension = yield* browser
        .suspend({ drain: "200 millis" })
        .pipe(Effect.scoped, Effect.flip);

      assert.strictEqual(suspension.reason._tag, "Busy");
      assert.strictEqual((yield* Effect.flip(cue.commit())).reason._tag, "Timeout");
      release.resolve();
      yield* page.press("a");
      yield* cue.commit();
      assert.strictEqual(submissions, 1);
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("select").inputValue()),
        "Two",
      );
    }).pipe(Effect.scoped),
  );

  it.live("refuses every page write, keeps reads and events live, and nests scopes", () =>
    Effect.gen(function* () {
      let judged = 0;

      const browser = yield* Chromium.open({
        guard: () =>
          Effect.sync(() => {
            judged += 1;
          }),
      });

      const page = yield* browser.newPage(document());
      const other = yield* browser.newPage(document("Other"));
      const [field] = yield* page.find({ role: "textbox", name: "Memo" });
      const [button] = yield* page.find({ role: "button", name: "Submit" });
      const [choice] = yield* page.find({ role: "combobox", name: "Choice" });
      const first = yield* scope;
      const second = yield* scope;
      const before = judged;
      const stopped = yield* browser.suspend().pipe(Scope.provide(first));
      const nested = yield* browser.suspend().pipe(Scope.provide(second));

      assert.deepStrictEqual(nested, stopped);

      const writes = [
        page.click(button?.ref ?? ""),
        page.type("library", { into: field?.ref ?? "" }),
        page.press("a"),
        page.hover(button?.ref ?? ""),
        page.scroll(),
        page.drag(button?.ref ?? "", field?.ref ?? ""),
        page.select(choice?.ref ?? "", ["Two"]),
        page.goto(document("Forbidden")),
        page.reload,
        page.back,
        other.press("b"),
      ];

      for (const write of writes) {
        const failure = yield* Effect.flip(write);

        assert.strictEqual(failure.reason._tag, "Suspended");
        assert.isFalse(failure.dispatched);
        assert.deepStrictEqual(consequence(failure), { lost: "nothing", repeat: "safe" });
      }
      assert.strictEqual(judged, before, "held input must not invoke the guard");
      assert.include((yield* page.snapshot()).text, "Input");
      assert.isAbove((yield* other.screenshot()).data.length, 0);

      const recorded = yield* browser.events({ after: stopped.since }).pipe(
        Stream.filter(({ event }) => event._tag === "Action"),
        Stream.take(writes.length),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
      );

      assert.strictEqual(recorded.length, writes.length);
      assert.isTrue(
        recorded.every(({ event }) => event._tag === "Action" && !event.dispatched && !event.ok),
      );

      // Direct native input represents a separate operator; the library's gate does not seize it.
      yield* Effect.promise(() => page.playwright.locator("input").fill("operator"));
      assert.include((yield* page.snapshot()).text, "operator");
      yield* Scope.close(first, Exit.void);
      assert.strictEqual((yield* Effect.flip(page.press("a"))).reason._tag, "Suspended");
      yield* Scope.close(second, Exit.void);
      yield* page.type("resumed", { into: field?.ref ?? "" });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("input").inputValue()),
        "resumed",
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "drains one operation, refuses already queued writes, and records before yielding authority",
    () =>
      Effect.gen(function* () {
        const browser = yield* Chromium.open();
        const page = yield* browser.newPage(document());
        const other = yield* browser.newPage(document("Other"));
        const held = yield* scope;
        const reply = yield* delayedReply(page, "press");
        const input = yield* page.press("a").pipe(Effect.forkChild);

        yield* reply.arrived;
        const queued = yield* page.press("b").pipe(Effect.flip, Effect.forkChild);
        const stopping = yield* browser.suspend().pipe(Scope.provide(held), Effect.forkChild);
        const refused = yield* Fiber.join(queued).pipe(Effect.timeout("1 second"));

        assert.strictEqual(refused.reason._tag, "Suspended");
        assert.isFalse(refused.dispatched);
        assert.strictEqual(reply.sent(), 1);
        assert.isUndefined(stopping.pollUnsafe());
        assert.include((yield* other.snapshot()).text, "Other");
        yield* reply.release;
        yield* Fiber.join(input);
        const stopped = yield* Fiber.join(stopping);

        const records = yield* browser
          .events({ after: 0 })
          .pipe(Stream.take(stopped.since), Stream.runCollect, Effect.timeout("2 seconds"));

        const action = records.findLast(({ event }) => event._tag === "Action" && event.ok);

        assert.strictEqual(action?.event._tag, "Action");
        assert.strictEqual(
          action?.event._tag === "Action" ? action.event.name : undefined,
          "press",
        );
        assert.isAtMost(action?.event.at ?? Infinity, stopped.at);
        assert.strictEqual((yield* Effect.flip(page.press("c"))).reason._tag, "Suspended");
      }).pipe(Effect.scoped),
  );

  for (const kind of ["press", "navigate"] as const)
    it.live(`keeps canceled ${kind} replies draining and removes a timed-out suspension`, () =>
      Effect.gen(function* () {
        const browser = yield* Chromium.open({
          navigationTimeout: kind === "press" ? "40 millis" : "2 seconds",
        });

        const page = yield* browser.firstPage;

        yield* Effect.promise(() => page.playwright.setContent("<input autofocus>"));
        const reply = yield* delayedReply(page, kind);
        const action = kind === "press" ? page.press("a") : page.goto(document("Arrived"));
        const input = yield* action.pipe(Effect.forkChild);

        yield* reply.arrived;
        yield* Fiber.interrupt(input);
        const recorded = (yield* browser.recentEvents).findLast((event) => event._tag === "Action");

        assert.strictEqual(recorded?._tag === "Action" ? recorded.error : undefined, "interrupted");
        assert.isTrue(recorded?._tag === "Action" && recorded.dispatched);

        const failure = yield* browser
          .suspend(kind === "press" ? undefined : { drain: "40 millis" })
          .pipe(Effect.scoped, Effect.flip);

        assert.strictEqual(failure.reason._tag, "Busy");
        assert.isFalse(failure.dispatched);
        yield* reply.release;
        // Failed suspension must leave no claim; the next public input may wait for the old ack.
        yield* page.press("b");
        const held = yield* scope;

        yield* browser.suspend().pipe(Scope.provide(held));
        assert.strictEqual((yield* Effect.flip(page.press("c"))).reason._tag, "Suspended");
      }).pipe(Effect.scoped),
    );

  it.live("abandons an interrupted drain and fails Closed when the browser is lost", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();
      const page = yield* browser.newPage(document());
      const reply = yield* delayedReply(page, "press");
      const input = yield* page.press("a").pipe(Effect.forkChild);

      yield* reply.arrived;
      const stopping = yield* browser.suspend().pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(stopping);
      yield* reply.release;
      yield* Fiber.join(input);
      yield* page.press("b");
      yield* Effect.promise(() => browser.context.close());
      const failure = yield* browser.suspend().pipe(Effect.scoped, Effect.flip);

      assert.strictEqual(failure.reason._tag, "Closed");
    }).pipe(Effect.scoped),
  );
});
