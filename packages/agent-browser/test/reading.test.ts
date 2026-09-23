import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type { BrowserSession } from "effect-browser/browser";
import { Observation, ObservedControl, Target } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";
import { Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

const target = Target.make({ generation: 1, pageId: "page", frameId: "frame" });
const url = "https://example.test/";

const reading = (
  options: {
    readonly id?: string;
    readonly text?: string;
    readonly textTruncated?: boolean;
    readonly controls?: ReadonlyArray<ObservedControl>;
  } = {},
) =>
  Observation.make({
    target,
    observationId: options.id ?? "observation-1",
    revision: 1,
    scope: "viewport",
    url,
    text: options.text ?? "",
    controls: options.controls ?? [],
    controlsTruncated: false,
    textTruncated: options.textTruncated ?? false,
    viewport: {
      width: 640,
      height: 480,
      clippedText: 0,
      coveredText: 0,
      uncertainText: 0,
      unreachableControls: 0,
      exhausted: false,
    },
  });

const control = (index: number, fields: Partial<ObservedControl> = {}) =>
  ObservedControl.make({
    elementId: `element-${index}`,
    kind: "button",
    label: `Control ${index}`,
    disabled: false,
    ...fields,
  });

const tools = Toolkit.merge(
  BrowserTools.toolkit,
  BrowserTools.readingToolkit,
  BrowserTools.observedToolkit,
);

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const call = (
  ready: Toolkit.WithHandler<Toolkit.Tools<typeof tools>>,
  name: "browser_inspect" | "browser_read_more" | "browser_click_and_inspect",
  params: unknown,
) =>
  // @ts-expect-error The name and its parameters are paired by each test.
  ready.handle(name, params, name).pipe(Effect.flatMap(Stream.runCollect));

const host = (browser: BrowserSession, options: BrowserTools.HostOptions = {}) =>
  BrowserTools.makeHost(browser, options).pipe(
    Effect.flatMap((made) =>
      tools.pipe(
        Effect.provide(made.layer),
        Effect.map((ready) => ({ made, ready })),
      ),
    ),
  );

it.effect(
  "inspect passes the model's find and scope with the host's bounds and default scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: Array<unknown> = [];

        const browser = scriptedSession({
          observe: (request) =>
            Effect.sync(() => {
              requests.push(request);

              return reading();
            }),
        });

        const { ready } = yield* host(browser);

        yield* call(ready, "browser_inspect", {});
        yield* call(ready, "browser_inspect", { find: "Total", scope: "document" });

        const narrow = yield* host(browser, {
          observationScope: "document",
          maxTextBytes: 4096,
          maxControls: 8,
          continuationBytes: 4096,
        });

        yield* call(narrow.ready, "browser_inspect", { find: "Pay" });
        expect(requests).toEqual([
          { scope: "viewport", maxTextBytes: 32768, maxControls: 16 },
          { scope: "document", match: "Total", maxTextBytes: 32768, maxControls: 16 },
          { scope: "document", match: "Pay", maxTextBytes: 4096, maxControls: 8 },
        ]);
      }),
    ),
);

it.effect("a reading is fitted to the result bound: text first, then trailing controls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const maximum = 16 * 1024;
      let next = reading({ text: "x".repeat(60_000) });
      const browser = scriptedSession({ observe: () => Effect.sync(() => next) });

      const { ready } = yield* host(browser, {
        maxTextBytes: 65536,
        continuationBytes: 65536,
        resultMaxBytes: maximum,
      });

      const [text] = yield* call(ready, "browser_inspect", {});

      expect(text?.isFailure).toBe(false);
      expect(text?.encodedResult).toMatchObject({ textTruncated: true, controlsTruncated: false });
      expect(bytes(text?.encodedResult)).toBeLessThanOrEqual(maximum);
      expect(bytes(text?.encodedResult)).toBeGreaterThan(maximum - 16);

      // Labels alone overflow the bound: trailing controls go, and a select that loses some
      // of its options says so. An option never outlives its select.
      const label = "L".repeat(256);

      next = reading({
        text: "words",
        controls: [
          ...Array.from({ length: 40 }, (_, i) => control(i, { label })),
          control(40, { kind: "select", label, multiple: false }),
          ...Array.from({ length: 20 }, (_, i) =>
            control(41 + i, { kind: "other", label, selectElementId: "element-40" }),
          ),
        ],
      });
      const [controls] = yield* call(ready, "browser_inspect", {});
      const fitted = yield* Schema.decodeUnknownEffect(Observation)(controls?.encodedResult);

      expect(bytes(controls?.encodedResult)).toBeLessThanOrEqual(maximum);
      expect(fitted.text).toBe("");
      expect(fitted).toMatchObject({ textTruncated: true, controlsTruncated: true });
      expect(fitted.controls.length).toBeGreaterThan(0);
      expect(fitted.controls.length).toBeLessThan(61);
      expect(fitted.controls.map((kept) => kept.elementId)).toEqual(
        Array.from({ length: fitted.controls.length }, (_, i) => `element-${i}`),
      );

      next = reading({
        controls: [
          control(0, { kind: "select", label: "Country" }),
          ...Array.from({ length: 60 }, (_, i) =>
            control(1 + i, { kind: "other", label, selectElementId: "element-0" }),
          ),
        ],
      });
      const [options] = yield* call(ready, "browser_inspect", {});
      const cut = yield* Schema.decodeUnknownEffect(Observation)(options?.encodedResult);

      expect(cut.controls[0]).toMatchObject({ elementId: "element-0", optionsTruncated: true });
      expect(cut.controls.length).toBeLessThan(61);
    }),
  ),
);

it.effect(
  "read_more continues the latest reading from where the model stopped and refuses others",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const text = "a".repeat(8192) + "b".repeat(8192) + "c".repeat(1000);
        let id = "observation-1";

        const browser = scriptedSession({
          observe: () => Effect.sync(() => reading({ id, text, textTruncated: true })),
        });

        const { made, ready } = yield* host(browser);

        const [first] = yield* call(ready, "browser_inspect", {});

        expect(first?.encodedResult).toMatchObject({ text: "a".repeat(8192), textTruncated: true });
        expect(yield* call(ready, "browser_read_more", { observationId: id })).toMatchObject([
          {
            isFailure: false,
            encodedResult: { text: "b".repeat(8192), remaining: true, textTruncated: true },
          },
        ]);
        expect(yield* call(ready, "browser_read_more", { observationId: id })).toMatchObject([
          { isFailure: false, encodedResult: { text: "c".repeat(1000), remaining: false } },
        ]);
        expect(yield* call(ready, "browser_read_more", { observationId: id })).toMatchObject([
          { isFailure: false, encodedResult: { text: "", remaining: false } },
        ]);
        id = "observation-2";
        yield* call(ready, "browser_inspect", {});
        expect(
          yield* call(ready, "browser_read_more", { observationId: "observation-1" }),
        ).toMatchObject([
          { isFailure: true, encodedResult: { reason: "stale", outcome: "undispatched" } },
        ]);
        expect((yield* made.toolFailures).failures.at(-1)).toMatchObject({
          toolName: "browser_read_more",
          error: { operation: "observe", reason: { _tag: "Stale" } },
        });
      }),
    ),
);

it.effect("an action's reading is fitted beside its result and continues through read_more", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const text = "d".repeat(40_000);

      const browser = scriptedSession({
        clickElement: () => Effect.succeed({ url }),
        observe: () => Effect.sync(() => reading({ id: "after", text })),
      });

      const { ready } = yield* host(browser, {
        maxTextBytes: 65536,
        continuationBytes: 65536,
        resultMaxBytes: 16 * 1024,
      });

      const [clicked] = yield* call(ready, "browser_click_and_inspect", {
        observationId: "before",
        elementId: "element-1",
      });

      expect(clicked).toMatchObject({
        isFailure: false,
        encodedResult: {
          action: { url },
          observation: { _tag: "Available", observation: { textTruncated: true } },
        },
      });
      expect(bytes(clicked?.encodedResult)).toBeLessThanOrEqual(16 * 1024);

      const followed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ observation: Schema.Struct({ observation: Observation }) }),
      )(clicked?.encodedResult);

      const [more] = yield* call(ready, "browser_read_more", { observationId: "after" });

      const next = yield* Schema.decodeUnknownEffect(BrowserTools.ReadMoreResult)(
        more?.encodedResult,
      );

      expect(next.remaining).toBe(true);
      expect(next.text.length).toBeGreaterThan(0);
      // The continuation starts exactly where the fitted reading stopped.
      expect(followed.observation.observation.text + next.text).toBe(
        text.slice(0, followed.observation.observation.text.length + next.text.length),
      );
    }),
  ),
);

it.effect("a browser policy that returns less text falls back to what the model is shown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const asked: Array<number> = [];

      const browser = scriptedSession({
        observe: (request) =>
          Effect.suspend(() => {
            asked.push(request?.maxTextBytes ?? 0);

            return (request?.maxTextBytes ?? 0) > 8192
              ? Effect.fail(
                  BrowserError.make({
                    operation: "observe",
                    reason: Reasons.Configuration.make({ path: "maxTextBytes" }),
                    outcome: "undispatched",
                  }),
                )
              : Effect.succeed(reading({ text: "short" }));
          }),
      });

      const { made, ready } = yield* host(browser);

      expect(yield* call(ready, "browser_inspect", {})).toMatchObject([
        { isFailure: false, encodedResult: { text: "short" } },
      ]);
      expect(asked).toEqual([32768, 8192]);
      expect((yield* made.toolFailures).failures).toEqual([]);
    }),
  ),
);

it.effect("a host's observe replaces how every reading is taken", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seen: Array<unknown> = [];
      let ordinary = 0;

      const browser = scriptedSession({
        clickElement: () => Effect.succeed({ url }),
        observe: () =>
          Effect.sync(() => {
            ordinary++;

            return reading();
          }),
      });

      const { ready } = yield* host(browser, {
        observe: (request, session) =>
          Effect.sync(() => {
            seen.push(request);
            expect(session).toBe(browser);

            return reading({ id: "custom", text: "from the host" });
          }),
      });

      expect(yield* call(ready, "browser_inspect", { find: "host" })).toMatchObject([
        { isFailure: false, encodedResult: { observationId: "custom", text: "from the host" } },
      ]);
      expect(
        yield* call(ready, "browser_click_and_inspect", {
          observationId: "custom",
          elementId: "element-1",
        }),
      ).toMatchObject([
        {
          isFailure: false,
          encodedResult: { observation: { observation: { observationId: "custom" } } },
        },
      ]);
      expect(seen).toEqual([
        { scope: "viewport", match: "host", maxTextBytes: 32768, maxControls: 16 },
        { scope: "viewport", maxTextBytes: 32768, maxControls: 16 },
      ]);
      expect(ordinary).toBe(0);
    }),
  ),
);
