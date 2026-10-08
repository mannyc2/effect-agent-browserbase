import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Random } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import { PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import * as Presentation from "../src/Presentation.ts";
import type { Snapshot } from "../src/Snapshot.ts";
import { unpaused } from "./fixtures.ts";

interface Input {
  readonly type?: string;
  readonly x?: number;
  readonly y?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly key?: string;
}

interface NativeEvent {
  readonly type: string;
  readonly key: string;
  readonly target: string;
  readonly trusted: boolean;
  readonly dy: number;
}

interface RecordedWindow {
  readonly events: Array<NativeEvent>;
}

const refOf = (snapshot: Snapshot, name: string) => {
  const ref = new RegExp('"' + name + '"[^\\n]*?\\[ref=(e\\d+)\\]').exec(snapshot.text)?.[1];

  if (ref === undefined) throw new Error("missing fixture ref " + name);

  return ref;
};

const setup = Effect.fnUntraced(function* (html: string, options: Options = {}) {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (context) => Effect.promise(() => context.close()),
  );

  const createSession = context.newCDPSession.bind(context);
  const calls: Array<{ readonly method: string; readonly input: Input }> = [];

  context.newCDPSession = async (target) => {
    const cdp = await createSession(target);
    const send = cdp.send.bind(cdp);

    const observed: CDPSession["send"] = (method, params) => {
      if (method === "Runtime.evaluate" || method.startsWith("Input."))
        calls.push({ method, input: (params as Input | undefined) ?? {} });

      return send(method, params);
    };

    cdp.send = observed;

    return cdp;
  };

  const browser = yield* makeBrowser(context, { id: "rhythm-test", provider: "test" }, options);
  // Performed, as viewers watch it, with no wait before each action.
  const page = (yield* Presentation.make({ pacing: unpaused })).view(yield* browser.newPage());

  yield* Effect.promise(() => page.playwright.setContent(html));
  yield* Effect.promise(() =>
    page.playwright.evaluate(() => {
      const recorded = window as unknown as RecordedWindow;

      Object.assign(recorded, { events: [] });
      for (const type of ["wheel", "mousedown", "mouseup", "click", "keydown", "keyup"] as const)
        document.addEventListener(type, (event) => {
          recorded.events.push({
            type,
            key: event instanceof KeyboardEvent ? event.key : "",
            target: event.target instanceof Element ? event.target.id : "",
            trusted: event.isTrusted,
            dy: event instanceof WheelEvent ? event.deltaY : 0,
          });
        });
    }),
  );
  const snapshot = yield* page.snapshot({ full: true });

  calls.splice(0);

  return { browser, page, snapshot, calls };
});

const events = (page: Page) =>
  Effect.promise(() =>
    page.playwright.evaluate(() => (window as unknown as RecordedWindow).events),
  );

const wheelCalls = (calls: ReadonlyArray<{ readonly input: Input }>) =>
  calls.filter((call) => call.input.type === "mouseWheel");

const distantButton =
  '<body style="margin:0;height:2400px"><button id="target" style="position:absolute;top:1500px;left:300px;width:160px;height:50px">Target</button></body>';

// Every scenario keeps native Chromium input and the public browser track. The protocol observer
// only counts work, so fallback and policy tests cannot pass by substituting an instant mock.
layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Rhythm",
  (it) => {
    it.effect(
      "reaches an offscreen control with visible wheels and records the dispatched track",
      () =>
        Effect.gen(function* () {
          const { browser, page, snapshot, calls } = yield* setup(distantButton);

          yield* page.click(refOf(snapshot, "Target")).pipe(Random.withSeed("visible-wheel"));
          const observed = yield* events(page);
          const wheels = observed.filter((event) => event.type === "wheel");

          assert.isAbove(wheels.length, 0);
          assert.isTrue(wheels.every((event) => event.trusted && event.dy > 0));
          assert.strictEqual(
            observed.filter((event) => event.type === "click" && event.target === "target").length,
            1,
          );
          assert.isBelow(
            observed.findIndex((event) => event.type === "wheel"),
            observed.findIndex((event) => event.type === "mousedown"),
          );

          const track = (yield* browser.recentEvents).filter(
            (event) => event._tag === "WheelScrolled",
          );

          assert.deepStrictEqual(
            track.map(({ x, y, dx, dy }) => ({ x, y, dx, dy })),
            wheelCalls(calls).map(({ input }) => ({
              x: input.x,
              y: input.y,
              dx: input.deltaX,
              dy: input.deltaY,
            })),
          );
          // The page's first input also maps its clock once: a world check and three probes.
          assert.isAtMost(
            calls.filter((call) => call.method === "Runtime.evaluate").length,
            16 + 4,
          );
        }),
    );

    it.effect("bounds blocked wheel work before revealing a nested target by fallback", () =>
      Effect.gen(function* () {
        const { page, snapshot, calls } = yield* setup(
          '<div id="scroller" style="width:500px;height:250px;overflow:auto;margin:20px"><div style="height:6000px;position:relative"><button id="target" style="position:absolute;top:5000px;left:200px">Target</button></div></div><script>document.addEventListener("wheel",event=>event.preventDefault(),{passive:false})</script>',
        );

        yield* page.click(refOf(snapshot, "Target")).pipe(Random.withSeed("blocked-wheel"));
        const observed = yield* events(page);

        assert.isAbove(wheelCalls(calls).length, 0);
        assert.isAtMost(wheelCalls(calls).length, 24);
        // The page's first input also maps its clock once: a world check and three probes.
        assert.isAtMost(calls.filter((call) => call.method === "Runtime.evaluate").length, 16 + 4);
        assert.strictEqual(
          observed.filter((event) => event.type === "click" && event.target === "target").length,
          1,
        );
        assert.isAbove(
          yield* Effect.promise(() =>
            page.playwright.locator("#scroller").evaluate((element) => element.scrollTop),
          ),
          0,
        );
      }),
    );

    it.effect("does not start approaching a denied or held offscreen target", () =>
      Effect.gen(function* () {
        const denied = yield* setup(distantButton, {
          guard: () => Effect.fail(new PolicyDenied({ detail: "not approved" })),
        });

        const rejected = yield* denied.page
          .click(refOf(denied.snapshot, "Target"))
          .pipe(Effect.flip);

        assert.strictEqual(rejected.reason._tag, "PolicyDenied");
        assert.isFalse(rejected.dispatched);
        assert.isEmpty(denied.calls.filter((call) => call.method.startsWith("Input.")));
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        let approvals = 0;

        const held = yield* setup(distantButton, {
          guard: () =>
            Effect.sync(() => {
              approvals += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(released)),
            ),
        });

        const action = yield* held.page
          .click(refOf(held.snapshot, "Target"))
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* Effect.sleep("75 millis");
        assert.isEmpty(held.calls.filter((call) => call.method.startsWith("Input.")));
        assert.strictEqual(
          yield* Effect.promise(() => held.page.playwright.evaluate(() => window.scrollY)),
          0,
        );
        yield* Deferred.succeed(released, undefined);
        yield* Fiber.join(action);
        assert.strictEqual(approvals, 1);
        assert.isAbove(wheelCalls(held.calls).length, 0);
      }),
    );

    it.effect("refuses activation if wheel handlers change the approved control", () =>
      Effect.gen(function* () {
        const { page, snapshot, calls } = yield* setup(
          distantButton +
            '<script>document.addEventListener("wheel",()=>{document.getElementById("target").textContent="Buy now"},{once:true})</script>',
          { guard: () => Effect.void },
        );

        const error = yield* page.click(refOf(snapshot, "Target")).pipe(Effect.flip);

        // The wheels only approached the target; with nothing pressed, the click had no effect.
        assert.strictEqual(error.reason._tag, "NotActionable");
        assert.isFalse(error.dispatched);
        assert.isAbove(wheelCalls(calls).length, 0);
        assert.isEmpty(calls.filter((call) => call.input.type === "mousePressed"));
        assert.isEmpty((yield* events(page)).filter((event) => event.type === "click"));
      }),
    );

    it.effect("refreshes both drag endpoints after scrolling and refuses an impossible span", () =>
      Effect.gen(function* () {
        const pair = (end: number) =>
          '<body style="margin:0;height:3000px"><button id="from" style="position:absolute;top:1400px;left:250px;width:100px;height:60px">From</button><button id="to" style="position:absolute;top:' +
          end +
          'px;left:420px;width:100px;height:60px">To</button></body>';

        const fitting = yield* setup(pair(1550));

        yield* fitting.page.drag(refOf(fitting.snapshot, "From"), refOf(fitting.snapshot, "To"));
        const observed = yield* events(fitting.page);

        assert.strictEqual(observed.find((event) => event.type === "mousedown")?.target, "from");
        assert.strictEqual(observed.findLast((event) => event.type === "mouseup")?.target, "to");
        const apart = yield* setup(pair(2600));

        const error = yield* apart.page
          .drag(refOf(apart.snapshot, "From"), refOf(apart.snapshot, "To"))
          .pipe(Effect.flip);

        assert.strictEqual(error.reason._tag, "NotActionable");
        assert.isEmpty(apart.calls.filter((call) => call.input.type === "mousePressed"));
      }),
    );

    it.effect("does not revalidate performed input when no guard is set", () =>
      Effect.gen(function* () {
        // Text that changes between any two tasks: there is no approval to invalidate.
        const { page } = yield* setup(
          '<p>Live <span id="clock">0</span></p><script>let tick = 0; const channel = new MessageChannel(); channel.port1.onmessage = () => { clock.textContent = String(++tick); channel.port2.postMessage(0); }; channel.port2.postMessage(0);</script>',
        );

        for (let index = 0; index < 3; index++) yield* page.press("ArrowDown");
        assert.lengthOf(
          (yield* events(page)).filter((event) => event.type === "keydown"),
          3,
        );
      }),
    );

    it.effect("stops typing when the page moves to another document mid-text", () =>
      Effect.gen(function* () {
        const { page, snapshot } = yield* setup(
          '<input id="note" aria-label="Note" oninput="if (this.value.length === 2) location.href = \'https://rhythm.test/armed\'">',
        );

        yield* Effect.promise(() =>
          page.playwright.context().route("https://rhythm.test/armed", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: "<title>Armed</title><button autofocus onclick=\"document.title='Deleted'\">Delete account</button>",
            }),
          ),
        );

        const error = yield* page
          .type("hello there friend", { into: refOf(snapshot, "Note") })
          .pipe(Random.withSeed("navigating-field"), Effect.flip);

        assert.strictEqual(error.reason._tag, "NotActionable");
        assert.isTrue(error.dispatched);
        assert.strictEqual(yield* page.title, "Armed");
      }),
    );
  },
);
