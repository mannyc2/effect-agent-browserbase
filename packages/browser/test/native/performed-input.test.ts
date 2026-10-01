import { createServer } from "node:http";

import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Layer } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import * as Plan from "effect-browser/plan";
import type { StepFailed } from "effect-browser/plan";
import { DefaultMotionProfile } from "effect-browser/plan-data";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

// Each page mirrors what a person would see into the DOM, so assertions read it publicly.
const pages: Record<string, string> = {
  // Two fields; every key event and the focused field are written to #log and #focus.
  "/keys": `<input aria-label="First" id="first"><input aria-label="Second" id="second">
<p id="log"></p><p id="focus"></p><p id="values"></p>
<script>
const log = [];
for (const type of ["keydown", "keyup"])
  document.addEventListener(type, (event) => {
    log.push(type + ":" + event.key);
    document.getElementById("log").textContent = log.join(",");
  }, true);
document.addEventListener("focusin", () => {
  document.getElementById("focus").textContent = document.activeElement.id;
});
document.addEventListener("input", () => {
  document.getElementById("values").textContent =
    first.value + "|" + second.value;
});
</script>`,
  // A one-time-code field that hands focus to the next box once two characters are in.
  "/otp": `<input aria-label="Code" id="a"><input aria-label="Next" id="b"><p id="mirror"></p>
<script>
a.addEventListener("input", () => { mirror.textContent = a.value; });
a.addEventListener("keyup", () => { if (a.value.length >= 2) b.focus(); });
</script>`,
  // Erasing the old value moves focus away before the first replacement character.
  "/erase": `<input aria-label="Name" id="field" value="old"><input aria-label="Other" id="other">
<p id="mirror">old</p>
<script>
field.addEventListener("input", () => { mirror.textContent = field.value; });
field.addEventListener("keyup", (event) => { if (event.key === "Backspace") other.focus(); });
</script>`,
  // Every key event costs the renderer 100 ms, standing in for a slow remote round trip.
  "/slow": `<input aria-label="Slow" id="slow"><p id="mirror">0</p>
<script>
const busy = () => { const until = performance.now() + 100; while (performance.now() < until) {} };
slow.addEventListener("keydown", busy);
slow.addEventListener("keyup", busy);
slow.addEventListener("input", () => { mirror.textContent = String(slow.value.length); });
</script>`,
  "/shift": `<input aria-label="Text" id="text"><p id="mirror"></p>
<script>
text.addEventListener("input", () => { mirror.textContent = text.value; });
</script>`,
  // A control far below the fold; the page reports its scroll offset and any hover.
  "/below": `<p id="scrolled">0</p><p id="hovered"></p><div style="height: 4000px"></div>
<button onmouseover="hovered.textContent = 'hovered'">Far</button>
<script>
addEventListener("scroll", () => { scrolled.textContent = String(Math.round(scrollY)); });
</script>`,
};

// Performed keys without pauses, so long texts stay fast while keeping every stroke's events.
const instant = {
  ...DefaultMotionProfile,
  keys: {
    interval: { minMillis: 0, maxMillis: 0 },
    hold: { minMillis: 0, maxMillis: 0 },
  },
};

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => void }>((resolve) => {
        const server = createServer((request, response) => {
          const body = pages[new URL(request.url ?? "/", "http://site").pathname];

          if (body === undefined) return void response.writeHead(404).end();
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><body>${body}</body>`);
        });

        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;

          resolve({ origin: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
        });
      }),
  ),
  (server) => Effect.sync(server.close),
);

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

const open = (path: string) =>
  Effect.gen(function* () {
    const { origin } = yield* site;
    const host = yield* externalChromium;

    const session = yield* Chromium.attach(host.endpoint, {
      policy: BrowserPolicy.unrestricted({ maxActions: 1000, maxElapsedMillis: 120_000 }),
    });

    yield* session.initialPage.navigate({ url: `${origin}${path}` });

    return session;
  });

const input = (label: string) =>
  ({
    _tag: "Descriptor",
    descriptor: { kind: "input", label, matchScope: "document" },
  }) as const;

const stepFailure = <A>(exit: Exit.Exit<A, StepFailed>) => {
  expect(Exit.isFailure(exit)).toBe(true);

  const failed = Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))
    : [];

  expect(failed).toHaveLength(1);

  return failed[0];
};

it.live("real CDP: a performed key that moves focus keeps its stroke balanced and its page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/keys");
      const page = session.initialPage;

      yield* page.run(
        {
          version: 1,
          steps: [
            { id: "focus", action: { _tag: "Click", target: input("First") } },
            { id: "next", action: { _tag: "Press", target: input("First"), key: "Tab" } },
            {
              id: "back",
              action: {
                _tag: "Press",
                target: input("Second"),
                key: "Tab",
                modifiers: ["Shift"],
              },
            },
          ],
        },
        { style: { seed: 7 } },
      );

      expect((yield* page.readText({ selector: "#log" })).text).toBe(
        "keydown:Tab,keyup:Tab,keydown:Shift,keydown:Tab,keyup:Tab,keyup:Shift",
      );
      expect((yield* page.readText({ selector: "#focus" })).text).toBe("first");
      // Nothing is left held: the next plain key lands unshifted where focus is now.
      yield* page.type({ text: "x" });
      expect((yield* page.readText({ selector: "#values" })).text).toBe("x|");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live(
  "real CDP: acknowledged performed keys stay performed when a later stroke loses focus",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* open("/otp");
        const page = session.initialPage;

        yield* page.click({ selector: "#a" });

        const failed = stepFailure(
          yield* page
            .run(
              {
                version: 1,
                steps: [
                  {
                    id: "code",
                    action: {
                      _tag: "Type",
                      target: input("Code"),
                      text: { _tag: "Literal", value: "123456" },
                    },
                  },
                ],
              },
              { style: { seed: 7 } },
            )
            .pipe(Effect.exit),
        );

        expect(failed).toMatchObject({
          stage: "AttemptFailed",
          error: { reason: { _tag: "NotFocused" }, outcome: "performed" },
          attempt: {
            outcome: "performed",
            result: { _tag: "AcknowledgedWithPostconditionFailure" },
            containment: { _tag: "NotRequired" },
          },
        });
        expect((yield* page.readText({ selector: "#mirror" })).text).toBe("12");
      }).pipe(Effect.provide(layer)),
    ),
);

it.live("real CDP: a performed Fill that already erased the value stays performed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/erase");
      const page = session.initialPage;

      const failed = stepFailure(
        yield* page
          .run(
            {
              version: 1,
              steps: [
                {
                  id: "name",
                  action: {
                    _tag: "Fill",
                    target: input("Name"),
                    value: { _tag: "Literal", value: "new" },
                  },
                },
              ],
            },
            { style: { seed: 7 } },
          )
          .pipe(Effect.exit),
      );

      expect(failed).toMatchObject({
        stage: "AttemptFailed",
        error: { reason: { _tag: "NotFocused" }, outcome: "performed" },
        attempt: { outcome: "performed", containment: { _tag: "NotRequired" } },
      });
      expect((yield* page.readText({ selector: "#mirror" })).text).toBe("");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: a performed Type its measured pace cannot finish stops between strokes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/slow");
      const page = session.initialPage;

      yield* page.click({ selector: "#slow" });
      const started = yield* Clock.currentTimeMillis;

      // 100 planned strokes fit the default 10 s action deadline; at 200 ms a stroke they cannot.
      const failed = stepFailure(
        yield* page
          .run(
            {
              version: 1,
              steps: [
                {
                  id: "slow",
                  action: {
                    _tag: "Type",
                    target: input("Slow"),
                    text: { _tag: "Literal", value: "abcdefghij".repeat(10) },
                  },
                },
              ],
            },
            { style: { seed: 11 } },
          )
          .pipe(Effect.exit),
      );

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5000);
      expect(failed).toMatchObject({
        stage: "AttemptFailed",
        error: { reason: { _tag: "TimingBudgetExceeded" }, outcome: "performed" },
        attempt: { outcome: "performed", containment: { _tag: "NotRequired" } },
      });
      // The page was not contained, and only whole strokes landed.
      const typed = Number((yield* page.readText({ selector: "#mirror" })).text);

      expect(typed).toBeGreaterThan(0);
      expect(typed).toBeLessThan(100);
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: performed typing produces shifted characters exactly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/shift");
      const page = session.initialPage;

      yield* page.run(
        {
          version: 1,
          steps: [
            {
              id: "text",
              action: {
                _tag: "Fill",
                target: input("Text"),
                value: { _tag: "Literal", value: "Ab! ~Z" },
              },
            },
          ],
        },
        { style: { seed: 991 } },
      );

      expect((yield* page.readText({ selector: "#mirror" })).text).toBe("Ab! ~Z");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: the same seed plans the same glide for the same geometry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/shift");

      const glide = Effect.gen(function* () {
        const ran = yield* session.initialPage.run(
          {
            version: 1,
            steps: [
              { id: "a", action: { _tag: "PointerMove", to: { x: 40, y: 40 } } },
              { id: "b", action: { _tag: "PointerMove", to: { x: 400, y: 300 } } },
            ],
          },
          { style: { seed: 5 } },
        );

        return (yield* session.timeline.snapshot()).events.flatMap(({ correlation, event }) =>
          event._tag === "Glide" && correlation?.runId === ran.runId && correlation.stepId === "b"
            ? [event.schedule.map(({ position }) => position)]
            : [],
        );
      });

      // Step b glides from a to b both times; only the first run's step a starts from nowhere.
      const first = yield* glide;

      expect(first).toHaveLength(1);
      expect(yield* glide).toEqual(first);
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: a performed Hover refuses an unseen control instead of scrolling to it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/below");
      const page = session.initialPage;

      const exit = yield* page
        .run(
          {
            version: 1,
            steps: [
              {
                id: "hover",
                action: {
                  _tag: "Hover",
                  target: {
                    _tag: "Descriptor",
                    descriptor: { kind: "button", label: "Far", matchScope: "document" },
                  },
                },
              },
            ],
          },
          { style: { seed: 3 } },
        )
        .pipe(Effect.exit);

      expect(stepFailure(exit)).toMatchObject({
        error: { reason: { _tag: "NotVisible" }, outcome: "undispatched" },
      });
      expect((yield* page.readText({ selector: "#scrolled" })).text).toBe("0");
      expect((yield* page.readText({ selector: "#hovered" })).text).toBe("");
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: a performed Press with modifiers sends the same key events as a plain one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pressed = (style: { readonly seed: number } | undefined) =>
        Effect.gen(function* () {
          const session = yield* open("/keys");
          const page = session.initialPage;

          yield* page.run(
            {
              version: 1,
              steps: [
                { id: "focus", action: { _tag: "Click", target: input("First") } },
                {
                  id: "letter",
                  action: { _tag: "Press", target: input("First"), key: "a", modifiers: ["Shift"] },
                },
                {
                  id: "digit",
                  action: { _tag: "Press", target: input("First"), key: "1", modifiers: ["Shift"] },
                },
              ],
            },
            style === undefined ? {} : { style },
          );

          return [
            (yield* page.readText({ selector: "#log" })).text,
            (yield* page.readText({ selector: "#values" })).text,
          ];
        });

      expect(yield* pressed({ seed: 17 })).toEqual(yield* pressed(undefined));
    }).pipe(Effect.provide(layer)),
  ),
);

it.live("real CDP: a long shifted performed Type keeps complete recording evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* open("/shift");
      const page = session.initialPage;
      const text = "AZ".repeat(128);

      const ran = yield* page.run(
        {
          version: 1,
          steps: [
            { id: "focus", action: { _tag: "Click", target: input("Text") } },
            {
              id: "text",
              action: {
                _tag: "Type",
                target: input("Text"),
                text: { _tag: "Literal", value: text },
              },
            },
          ],
        },
        { style: { seed: 23, motion: instant }, within: "60 seconds" },
      );

      expect((yield* page.readText({ selector: "#mirror" })).text).toBe(text);
      expect(ran.steps.map((step) => step.recorded._tag)).toEqual(["Complete", "Complete"]);
      expect((yield* Plan.recorded(ran)).steps).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  ),
);
