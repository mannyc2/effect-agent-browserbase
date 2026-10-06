import { assert, layer } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Random } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser, type Options } from "../src/Browser.ts";
import { PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import type { Snapshot } from "../src/Snapshot.ts";
import * as Tools from "../src/Tools.ts";

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

  const browser = yield* makeBrowser(
    context,
    { id: "rhythm-test", provider: "test" },
    { humanize: true, ...options },
  );

  const page = yield* browser.newPage();

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

        assert.strictEqual(error.reason._tag, "NotActionable");
        assert.isTrue(error.dispatched);
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

    it.effect("corrects opted-in prose through the public tool and records native key events", () =>
      Effect.gen(function* () {
        const text = "Please bring bread.";

        const { browser, page, snapshot, calls } = yield* setup(
          '<label>Notes<textarea id="notes"></textarea></label>',
        );

        const ref = refOf(snapshot, "Notes");
        const tools = yield* Tools.make().pipe(Effect.provideService(Browser, browser));

        yield* page.hover(ref);
        yield* tools.handlers.browser_type({ ref, text, prose: true }).pipe(Random.withSeed(0));
        assert.strictEqual(
          yield* Effect.promise(() => page.playwright.locator("#notes").inputValue()),
          text,
        );

        const observed = (yield* events(page)).filter(
          (event) => event.type === "keydown" || event.type === "keyup",
        );

        const corrections = observed.filter(
          (event) => event.type === "keydown" && event.key === "Backspace",
        );

        assert.strictEqual(corrections.length, 1);
        assert.isTrue(observed.every((event) => event.trusted));
        assert.deepStrictEqual(
          (yield* browser.recentEvents)
            .filter((event) => event._tag === "KeyChanged")
            .map(({ key, phase }) => ({ key, phase })),
          observed.map((event) => ({
            key: event.key,
            phase: event.type === "keydown" ? "down" : "up",
          })),
        );
        assert.strictEqual(calls.filter((call) => call.method === "Input.insertText").length, 0);

        const editor = yield* setup(
          '<div role="textbox" aria-label="Notes" id="notes" contenteditable="true" style="width:300px;height:100px"></div>',
        );

        const editorRef = refOf(editor.snapshot, "Notes");

        yield* editor.page.hover(editorRef);
        yield* editor.page.type(text, { into: editorRef, prose: true }).pipe(Random.withSeed(0));
        assert.strictEqual(
          yield* Effect.promise(() => editor.page.playwright.locator("#notes").innerText()),
          text,
        );
        assert.strictEqual(
          (yield* events(editor.page)).filter(
            (event) => event.type === "keydown" && event.key === "Backspace",
          ).length,
          1,
        );
      }),
    );

    it.effect("keeps sensitive fields exact even when prose is requested", () =>
      Effect.gen(function* () {
        for (const html of [
          '<label>Notes<input id="notes"></label>',
          '<label>Notes<textarea id="notes" inputmode="decimal"></textarea></label>',
          '<label>Notes<textarea id="notes" autocomplete="new-password"></textarea></label>',
          '<form id="order"><label>Notes<textarea id="notes"></textarea></label><button>Place order</button></form>',
        ]) {
          const { page, snapshot } = yield* setup(html);
          const ref = refOf(snapshot, "Notes");
          const text = "Please bring bread.";

          yield* page.hover(ref);
          yield* page.type(text, { into: ref, prose: true }).pipe(Random.withSeed(0));
          assert.strictEqual(
            yield* Effect.promise(() => page.playwright.locator("#notes").inputValue()),
            text,
          );
          assert.isEmpty((yield* events(page)).filter((event) => event.key === "Backspace"));
        }
      }),
    );

    it.effect("keeps numeric, address-like, implicit, appended and ordinary text exact", () =>
      Effect.gen(function* () {
        for (const text of [
          "Please bring bread. 2",
          "Please bring bread. https://example.test",
          "Please bring bread. example.test, thanks",
          "Please bring bread. hello@example.test",
        ]) {
          const { page, snapshot } = yield* setup(
            '<label>Notes<textarea id="notes"></textarea></label>',
          );

          const ref = refOf(snapshot, "Notes");

          yield* page.hover(ref);
          yield* page.type(text, { into: ref, prose: true }).pipe(Random.withSeed(0));
          assert.strictEqual(
            yield* Effect.promise(() => page.playwright.locator("#notes").inputValue()),
            text,
          );
          assert.isEmpty((yield* events(page)).filter((event) => event.key === "Backspace"));
        }
        for (const mode of ["ordinary", "append", "implicit", "plain"] as const) {
          const { page, snapshot } = yield* setup(
            '<label>Notes<textarea id="notes"></textarea></label>',
            { humanize: mode !== "plain" },
          );

          const ref = refOf(snapshot, "Notes");
          const text = "Please bring bread.";

          yield* page.hover(ref);
          yield* Effect.promise(() => page.playwright.locator("#notes").focus());
          yield* page
            .type(text, {
              into: mode === "implicit" ? undefined : ref,
              prose: mode !== "ordinary",
              replace: mode !== "append",
            })
            .pipe(Random.withSeed(0));
          assert.strictEqual(
            yield* Effect.promise(() => page.playwright.locator("#notes").inputValue()),
            text,
          );
          assert.isEmpty((yield* events(page)).filter((event) => event.key === "Backspace"));
        }
      }),
    );

    it.effect(
      "refuses Enter when a page prevents correction from producing the requested prose",
      () =>
        Effect.gen(function* () {
          const { browser, page, snapshot } = yield* setup(
            '<label>Notes<textarea id="notes" onkeydown="if(event.key===\'Backspace\')event.preventDefault()"></textarea></label>',
          );

          const ref = refOf(snapshot, "Notes");

          yield* page.hover(ref);

          const error = yield* page
            .type("Please bring bread.", { into: ref, prose: true, submit: true })
            .pipe(Random.withSeed(0), Effect.flip);

          assert.strictEqual(error.reason._tag, "NotActionable");
          assert.isTrue(error.dispatched);
          assert.notStrictEqual(
            yield* Effect.promise(() => page.playwright.locator("#notes").inputValue()),
            "Please bring bread.",
          );
          const observed = yield* events(page);

          assert.strictEqual(
            observed.filter((event) => event.type === "keydown" && event.key === "Backspace")
              .length,
            1,
          );
          assert.isEmpty(observed.filter((event) => event.key === "Enter"));
          assert.strictEqual(
            (yield* browser.recentEvents).filter(
              (event) => event._tag === "Action" && event.name === "type",
            ).length,
            1,
          );
        }),
    );

    it.effect("rechecks prose eligibility after focus handlers change the field", () =>
      Effect.gen(function* () {
        const { page, snapshot } = yield* setup(
          '<label>Notes<textarea id="notes" onfocus="this.autocomplete=\'new-password\'"></textarea></label>',
        );

        const ref = refOf(snapshot, "Notes");

        const error = yield* page
          .type("Please bring bread.", { into: ref, prose: true })
          .pipe(Random.withSeed(0), Effect.flip);

        assert.strictEqual(error.reason._tag, "NotActionable");
        assert.isTrue(error.dispatched);
        assert.isEmpty((yield* events(page)).filter((event) => event.type === "keydown"));
      }),
    );
    it.effect("keeps functional navigation settling when the presentation pause is short", () =>
      Effect.gen(function* () {
        const { page, snapshot } = yield* setup(
          '<button id="target" onclick="setTimeout(()=>location.href=\'https://rhythm.test/next\',200)">Continue</button>',
        );

        yield* Effect.promise(() =>
          page.playwright.context().route("https://rhythm.test/next", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: "<title>Arrived</title><h1>The next page</h1>",
            }),
          ),
        );
        // The minimum presentation pause must finish before the 200ms navigation. A constant
        // Random service keeps this regression sensitive when earlier sampling changes.
        yield* page.click(refOf(snapshot, "Continue")).pipe(
          Effect.provideService(Random.Random, {
            nextIntUnsafe: () => 0,
            nextDoubleUnsafe: () => 0,
          }),
        );
        assert.strictEqual(yield* page.title, "Arrived");
      }),
    );
  },
);
