import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  ClickRequest,
  NavigateRequest,
  ObservedElement,
  PressRequest,
  TypeRequest,
} from "effect-browser/browser-data";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";

const Log = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      type: Schema.Literals(["keydown", "keyup"]),
      key: Schema.String,
      trusted: Schema.Boolean,
      shift: Schema.Boolean,
      ctrl: Schema.Boolean,
      at: Schema.String,
    }),
  ),
  inputs: Schema.Array(Schema.Struct({ data: Schema.NullOr(Schema.String), at: Schema.String })),
  submits: Schema.Finite,
  first: Schema.String,
  second: Schema.String,
  area: Schema.String,
  inner: Schema.String,
  focused: Schema.String,
});

const read = (page: Page) =>
  Effect.promise<unknown>(() => page.evaluate("window.read()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Log)),
  );

it.live("real CDP: keys are real input, delivered to whatever the browser says has focus", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          // Focus is the page's business: a real click gives it, and keys then follow it.
          yield* handle.click(ClickRequest.make({ selector: "#first" }));
          const typed = yield* handle.type(TypeRequest.make({ text: "Hi!" }));

          expect(typed.kind).toBe("type");
          expect(typed.target).toEqual(yield* session.target);
          expect(typed.completedMonotonicNanos).toBeGreaterThanOrEqual(typed.startedMonotonicNanos);
          const afterText = yield* read(native);

          // A stroke each way for every character, made by the browser, at the focused field:
          // what `fill` never raises, and what a scripted `dispatchEvent` cannot make trusted.
          expect(afterText.first).toBe("Hi!");
          expect(afterText.keys.map((event) => `${event.type} ${event.key}`)).toEqual([
            "keydown H",
            "keyup H",
            "keydown i",
            "keyup i",
            "keydown !",
            "keyup !",
          ]);
          expect(afterText.keys.every((event) => event.trusted && event.at === "first")).toBe(true);
          // The pinned engine's limit: a shifted character is its own key, with no Shift held.
          expect(afterText.keys.some((event) => event.shift)).toBe(false);

          // An editing key edits, so a slip can be filmed as it happens and then corrected.
          yield* handle.press(PressRequest.make({ key: "Backspace" }));
          expect((yield* read(native)).first).toBe("Hi");

          // Focus traversal is the browser's own, in both directions, and tabbing into a field
          // selects what it holds, which is why the caret is sent to the end further down.
          yield* handle.press(PressRequest.make({ key: "Tab" }));
          expect((yield* read(native)).focused).toBe("second");
          const back = yield* handle.press(PressRequest.make({ key: "Tab", modifiers: ["Shift"] }));

          expect(back.kind).toBe("press");
          const afterTab = yield* read(native);

          expect(afterTab.focused).toBe("first");
          expect(afterTab.keys.find((event) => event.key === "Tab" && event.shift)?.trusted).toBe(
            true,
          );

          // Control+K alone is a native delete command on macOS. This chord has no
          // editing command in the pinned engine, while still delivering real modifiers.
          yield* handle.press(PressRequest.make({ key: "k", modifiers: ["Control", "Shift"] }));
          const afterChord = yield* read(native);

          expect(afterChord.keys.some((event) => event.key === "k" && event.ctrl)).toBe(true);
          expect(afterChord.first).toBe("Hi");

          // A page that reads the modifier needs Shift really held, and the key is spelled as
          // the page will see it: the capital. Spelled "a", the engine sends "a" with Shift down.
          // ArrowRight collapses the selected field text to its end on both host platforms.
          yield* handle.press(PressRequest.make({ key: "ArrowRight" }));
          yield* handle.press(PressRequest.make({ key: "A", modifiers: ["Shift"] }));
          const afterShift = yield* read(native);

          expect(afterShift.keys.some((event) => event.key === "A" && event.shift)).toBe(true);
          expect(afterShift.first).toBe("HiA");

          // Select-all is the browser's own chord, so what is typed next replaces the selection.
          // The character is one no US key produces. It is committed as text, the way an input
          // method commits it: the field changes and no key event says so.
          yield* handle.press(
            PressRequest.make({
              key: "a",
              modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
            }),
          );
          const strokesBefore = (yield* read(native)).keys.length;

          yield* handle.type(TypeRequest.make({ text: "é" }));
          const afterInserted = yield* read(native);

          expect(afterInserted.first.normalize()).toBe("é");
          expect(afterInserted.keys).toHaveLength(strokesBefore);
          expect(afterInserted.inputs.at(-1)).toEqual({ data: "é", at: "first" });

          // Enter is dispatched, not awaited: what the page does with it is waited for.
          yield* handle.press(PressRequest.make({ key: "Enter" }));
          expect((yield* settle(read(native), (log) => log.submits > 0)).submits).toBe(1);
          yield* session.close;
        }),
      );
    }),
  ),
);

/** Runs the same guard with and without the focus emulation page control switches off. */
const guarded = (options: { readonly pageControl?: boolean }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          yield* handle.click(ClickRequest.make({ selector: "#first" }));

          // Meant for one field while another has focus: nothing is sent to either.
          for (const attempt of [
            handle.type(TypeRequest.make({ text: "secret", into: "#second" })),
            handle.press(PressRequest.make({ key: "Enter", into: "#area" })),
          ]) {
            const refused = yield* attempt.pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") {
              expect(refused.failure.reason._tag).toBe("NotFocused");
              expect(refused.failure.outcome).toBe("undispatched");
            }
          }
          const untouched = yield* read(native);

          expect(untouched.keys).toEqual([]);
          expect(untouched.submits).toBe(0);
          expect([untouched.first, untouched.second, untouched.area]).toEqual(["", "", ""]);

          // The field that has focus, and anything that holds it, admit the same keys.
          yield* handle.type(TypeRequest.make({ text: "a", into: "#first" }));
          yield* handle.type(TypeRequest.make({ text: "b", into: "#form" }));
          expect((yield* read(native)).first).toBe("ab");

          // Focus inside an open shadow root belongs to its host, as it does for the page.
          yield* handle.click(ClickRequest.make({ selector: "#host" }));
          yield* handle.type(TypeRequest.make({ text: "c", into: "#host" }));
          expect((yield* read(native)).inner).toBe("c");
          yield* session.close;
        }),
        options,
      );
    }),
  );

it.live(
  "real CDP: `into` sends keys to the one element that already has focus, or sends nothing",
  () => guarded({}),
);

it.live("real CDP: the focus guard does not depend on the engine emulating focus", () =>
  guarded({ pageControl: true }),
);

it.live("real CDP: real typing keeps the exactness and admission an observed node has", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const childUrl = new URL("/keyframe", f.url).href;

          const frames = yield* settle(session.frames, (listed) =>
            listed.some((frame) => frame.name === "child" && frame.url === childUrl),
          );

          expect(frames.some((frame) => frame.name === "child" && frame.url === childUrl)).toBe(
            true,
          );
          const observation = yield* session.observe();

          const named = (label: string) => {
            const control = observation.controls.find((candidate) => candidate.label === label);

            assert.ok(control, label);

            return ObservedElement.make({
              observationId: observation.observationId,
              elementId: control.elementId,
            });
          };

          const second = named("Second");

          // It has not been given focus, so the exact node named receives nothing.
          const early = yield* session.typeElement(second, "early").pipe(Effect.result);

          expect(early._tag).toBe("Failure");
          if (early._tag === "Failure") expect(early.failure.reason._tag).toBe("NotFocused");

          yield* session.clickElement(second);
          // A click is a mutation, so what was observed before it names nothing any more.
          const stale = yield* session.typeElement(second, "stale").pipe(Effect.result);

          expect(stale._tag).toBe("Failure");
          if (stale._tag === "Failure") {
            expect(stale.failure.reason._tag).toBe("Stale");
            expect(stale.failure.outcome).toBe("undispatched");
          }

          const fresh = yield* session.observe();
          const field = fresh.controls.find((candidate) => candidate.label === "Second");

          assert.ok(field);

          const reference = ObservedElement.make({
            observationId: fresh.observationId,
            elementId: field.elementId,
          });

          // The host decides on facts read from that node just now, before any key is sent.
          const denied = yield* session
            .typeElement(reference, "denied", { admit: () => false })
            .pipe(Effect.result);

          expect(denied._tag).toBe("Failure");
          if (denied._tag === "Failure") {
            expect(denied.failure.operation).toBe("type");
            expect(denied.failure.reason._tag).toBe("Denied");
            expect(denied.failure.outcome).toBe("undispatched");
          }
          expect((yield* read(native)).keys).toEqual([]);

          const typed = yield* session.typeElement(reference, "ok", {
            admit: (facts) => facts.kind === "input" && facts.editable,
          });

          expect(typed.kind).toBe("type");
          expect((yield* read(native)).second).toBe("ok");
          yield* session.close;
        }),
      );
    }),
  ),
);

const InFrame = Schema.Struct({
  inside: Schema.String,
  active: Schema.String,
  focused: Schema.Boolean,
});

it.live("real CDP: keys follow focus across frames, and a frame that lost it admits nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);

          const frames = yield* settle(session.frames, (listed) =>
            listed.some((frame) => frame.name === "child" && frame.url.endsWith("/keyframe")),
          );

          const child = frames.find((frame) => frame.name === "child");
          const main = frames.find((frame) => frame.parentFrameId === null);

          assert.ok(child);
          assert.ok(main);

          const readChild = Effect.promise<unknown>(
            () => native.frame({ name: "child" })?.evaluate("window.read()") ?? Promise.resolve(),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InFrame)));

          yield* session.selectFrame(child.frameId);

          yield* session.click(ClickRequest.make({ selector: "#inside" }));
          yield* session.type(TypeRequest.make({ text: "in", into: "#inside" }));
          expect(yield* readChild).toEqual({ inside: "in", active: "inside", focused: true });

          // The person moves on to a field in the page around the frame.
          yield* session.selectFrame(main.frameId);

          yield* session.click(ClickRequest.make({ selector: "#first" }));
          yield* session.selectFrame(child.frameId);

          // Focus left the frame, and the browser took the field's focus with it, so keys would
          // not reach it. Asking for that field sends nothing.
          expect(yield* readChild).toEqual({ inside: "in", active: "", focused: false });

          const refused = yield* session
            .type(TypeRequest.make({ text: "lost", into: "#inside" }))
            .pipe(Effect.result);

          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure") {
            expect(refused.failure.reason._tag).toBe("NotFocused");
            expect(refused.failure.outcome).toBe("undispatched");
          }

          // Unguarded keys go where the browser sends them: to what has focus, in the page
          // around the selected frame, never to the frame merely because it is selected.
          yield* session.type(TypeRequest.make({ text: "out" }));
          expect((yield* read(native)).first).toBe("out");
          expect((yield* readChild).inside).toBe("in");
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: keys meant for a held page are refused, never queued for when it resumes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const handle = session;

          yield* handle.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          yield* handle.click(ClickRequest.make({ selector: "#first" }));
          const [native] = f.nativePages(session.reference.sessionId);
          const [page] = yield* session.pages;

          assert.ok(native);
          assert.ok(page);
          const receipt = yield* PageControl.suspend(session, page);

          for (const input of [
            handle.type(TypeRequest.make({ text: "held" })),
            handle.press(PressRequest.make({ key: "Enter" })),
          ]) {
            const refused = yield* input.pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") expect(refused.failure.outcome).toBe("undispatched");
          }
          yield* PageControl.resume(session, receipt);
          // A key the browser had been handed would arrive now. Given time to, none does.
          yield* Effect.sleep(300);
          const resumed = yield* read(native);

          expect(resumed.keys).toEqual([]);
          expect(resumed.first).toBe("");
          expect(resumed.submits).toBe(0);

          // The same handle works again once the hold is over.
          yield* handle.type(TypeRequest.make({ text: "go" }));
          expect((yield* read(native)).first).toBe("go");
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);

it.live("real CDP: keys through a handle bound to another page reach neither page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const first = yield* session.retain;

          yield* first.navigate(NavigateRequest.make({ url: `${f.url}keyboard` }));
          yield* first.click(ClickRequest.make({ selector: "#first" }));
          yield* session.selectPage(yield* session.createPage);
          const second = yield* session.retain;

          yield* second.navigate(NavigateRequest.make({ url: `${f.url}keyboard#second` }));

          for (const input of [
            first.type(TypeRequest.make({ text: "lost" })),
            first.press(PressRequest.make({ key: "Enter" })),
          ]) {
            const refused = yield* input.pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") {
              expect(refused.failure.reason._tag).toBe("Stale");
              expect(refused.failure.outcome).toBe("undispatched");
            }
          }
          for (const native of f.nativePages(session.reference.sessionId)) {
            const log = yield* read(native);

            expect(log.keys).toEqual([]);
            expect(log.submits).toBe(0);
          }
          yield* session.close;
        }),
      );
    }),
  ),
);
