/**
 * The page's actions: click, hover, drag, type, press, scroll and select, each sent in a style,
 * plainly or performed for viewers. Each runs through
 * `perform`, which admits it, puts it to the input guard and records it. A click, a key or a scroll
 * then waits for the page to settle: a task and a frame, and a document if the input asked for one.
 */
import { Duration, Effect } from "effect";

import { NotActionable, StaleRef } from "../../BrowserError.ts";
import type { ClickOptions, PressOptions, ScrollOptions, Target, TypeOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext, refuse } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import * as Dispatch from "./dispatch.ts";
import { buttonAt } from "./dispatch.ts";
import * as Script from "./edit.inpage.ts";
import * as Guard from "./guard.ts";
import * as Keyboard from "./keyboard.ts";
import * as Keys from "./keys.ts";
import * as Perform from "./perform.ts";
import * as Pointer from "./pointer.ts";
import * as Settle from "./settle.ts";
import * as Targets from "./targets.ts";

const partsOf = (page: PageContext, bridge: Bridge, viewport: Viewport) => {
  const dispatch = Dispatch.make(page);
  const pointer = Pointer.make(page, dispatch, viewport);
  const guard = Guard.make(page, bridge);
  const settling = Settle.make(page, bridge);

  return {
    page,
    ...settling,
    viewportFor: viewport.viewportFor,
    perform: Perform.make(page, dispatch),
    ...guard,
    ...Targets.make(viewport, guard, pointer, dispatch, settling),
    ...pointer,
    ...Keyboard.make(page, bridge, dispatch),
    sendMouse: dispatch.sendMouse,
    flush: dispatch.flush,
  };
};

type Parts = ReturnType<typeof partsOf>;

const named = (target: Target) => (typeof target === "string" ? target : `${target.x},${target.y}`);

/** The ref a target names, if it names one rather than a point. */
const refOf = (target: Target | undefined) => (typeof target === "string" ? target : undefined);

/** Key names have a finite vocabulary beyond the action's structural schema. */
const pressed = (keys: string) => {
  const parts = Keys.parts(keys);

  return parts === undefined
    ? refuse("press", `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`)
    : Effect.succeed(parts);
};

const click = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, moveTo, sendMouse, flush, mark, settle } = input;

  return (target: Target, clickOptions: ClickOptions = {}) =>
    perform(
      "click",
      {
        target: named(target),
      },
      settings.actionTimeout,
      preparePolicy("click", { target: refOf(target) }, [target]),
      (marks, approval) =>
        Effect.gen(function* () {
          const resolved = yield* targetFor("click", target, approval, marks);
          const { point } = resolved;
          const button = clickOptions.button ?? "left";
          const count = Math.max(1, Math.min(3, clickOptions.clickCount ?? 1));

          yield* marks.at(point);
          yield* marks.on(resolved);
          yield* moveTo("click", marks, point, resolved.cursor);
          yield* Guard.check(approval, { presses: [{ index: 0, ...point }] });
          const before = mark();

          yield* marks.sent;
          for (let index = 1; index <= count; index++) {
            // An earlier click of a multi-click can replace the approved control under the
            // pointer. Under a guard, its handlers run before the next press is checked and sent.
            if (index > 1)
              yield* Guard.check(
                approval,
                { presses: [{ index: 0, ...point }] },
                flush("click", marks.input),
              ).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "StaleRef",
                  () =>
                    failWith(
                      "click",
                      new NotActionable({
                        detail:
                          "an earlier click removed the approved target, so no further press was sent",
                      }),
                    ),
                ),
              );
            yield* sendMouse("click", marks.input, buttonAt("mousePressed", point, button, index));

            // A hold the caller asks for is the click's own; the style's is presentation.
            const hold = clickOptions.holdMillis ?? (yield* marks.style.hold);

            if (clickOptions.holdMillis === undefined) yield* marks.present(hold);
            if (hold > 0) yield* Effect.sleep(Duration.millis(hold));
            yield* sendMouse("click", marks.input, buttonAt("mouseReleased", point, button, index));
          }
          yield* flush("click", marks.input);
          yield* settle("click", before);

          return resolved;
        }),
    );
};

const hover = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, moveTo, flush } = input;

  return (target: Target) =>
    perform(
      "hover",
      { target: named(target) },
      settings.actionTimeout,
      preparePolicy("hover", { target: refOf(target) }, [target]),
      (marks, approval) =>
        Effect.gen(function* () {
          const resolved = yield* targetFor("hover", target, approval, marks);
          const { point } = resolved;

          yield* marks.at(point);
          yield* marks.on(resolved);
          yield* moveTo("hover", marks, point, resolved.cursor, "hover");
          yield* flush("hover", marks.input);
        }),
    );
};

const drag = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, resolve, moveTo, sendMouse, flush } = input;

  return (from: Target, to: Target) =>
    perform(
      "drag",
      { target: `${JSON.stringify(from)} -> ${JSON.stringify(to)}` },
      settings.actionTimeout,
      preparePolicy("drag", {}, [from, to]),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* targetFor("drag", from, approval, marks);
          yield* targetFor("drag", to, approval, marks);
          // Bringing the second endpoint into view may move the first. Both must still be
          // actionable in the final viewport before the first button press.
          const start = yield* resolve("drag", from, approval, false);
          const end = yield* resolve("drag", to, approval, false);

          yield* marks.at(end.point);
          yield* marks.on(start, end);
          yield* moveTo("drag", marks, start.point, start.cursor);
          // Both ends are checked before the button goes down: once it is down, a release cannot
          // be withheld, and a dragged element under the pointer would hide the drop target.
          yield* Guard.check(approval, {
            presses: [
              { index: 0, ...start.point },
              { index: 1, ...end.point },
            ],
          });
          yield* marks.sent;
          yield* sendMouse("drag", marks.input, buttonAt("mousePressed", start.point));
          yield* moveTo("drag", marks, end.point, end.cursor, "drag");
          yield* sendMouse("drag", marks.input, buttonAt("mouseReleased", end.point));
          yield* flush("drag", marks.input);
        }),
    );
};

const typeText = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, mutate, targetFor, moveTo, sendMouse, flush, evaluate } = input;
  const { currentDocument, sameDocument, keyStroke, typeEvent, mark, settle } = input;

  return (text: string, typeOptions: TypeOptions = {}) =>
    perform(
      "type",
      {
        target: typeOptions.into,
        text,
        secret: true,
      },
      settings.actionTimeout,
      preparePolicy("type", { target: typeOptions.into, text }, [typeOptions.into ?? null], {
        submit: typeOptions.submit ?? false,
      }),
      (marks, approval) =>
        Effect.gen(function* () {
          const events = yield* marks.style.typing(text, approval !== undefined);
          const replace = typeOptions.replace ?? true;
          const into = typeOptions.into;

          // A typed space or letter can press a focused button or change a control. Refuse
          // those before any input, on every path.
          const asked = scriptCall("typeable", into ?? null, typeOptions.secret === true);

          const typeable = yield* evaluate("type", asked, approval).pipe(
            Effect.flatMap(decodeWith("type", Script.TypeableResultSchema)),
          );

          if ("error" in typeable)
            return yield* failWith(
              "type",
              typeable.error === "stale" && into !== undefined
                ? new StaleRef({ ref: into })
                : new NotActionable({ detail: typeable.detail }),
            );
          if (typeable.subject !== undefined) yield* marks.on(typeable.subject);

          const since = yield* currentDocument("type");
          let secret = typeable.secret;

          if (into !== undefined) {
            const target = yield* targetFor("type", into, approval, marks);

            yield* marks.at(target.point);
            yield* marks.on(target);
            // Viewers see the pointer click into the field.
            if (marks.style.shown) {
              yield* moveTo("type", marks, target.point, target.cursor);
              yield* Guard.check(approval, { presses: [{ index: 0, ...target.point }] });
              yield* marks.sent;
              for (const type of ["mousePressed", "mouseReleased"] as const)
                yield* sendMouse("type", marks.input, buttonAt(type, target.point));
              yield* flush("type", marks.input);
            }

            // Focusing can run page handlers, including navigation, before the script returns.
            yield* marks.sent;

            // A page may answer the press with another field of the same name in the field's
            // place, focused, as a typeahead does: the keys follow it, unless a guard approved
            // this field and no other, or the field is secret, as its replacement may not be.
            const follow =
              marks.style.shown && approval === undefined && !secret && target.name !== ""
                ? target.name
                : null;

            const focused = yield* mutate(
              "type",
              scriptCall("focus", into, replace, follow),
              approval,
            ).pipe(Effect.flatMap(decodeWith("type", Script.FocusResultSchema)));

            if ("error" in focused) return yield* Guard.editFailure("type", into, focused);
            secret ||= focused.secret;
          }
          if (!secret) yield* marks.reveal;
          yield* Guard.check(approval, { focused: true });
          yield* marks.sent;

          // A key's handlers can move focus, and later keys then reach a control nobody approved.
          // Under a guard, the field is approved once: plain text goes in one insertion, which no
          // handler can split, and keys typed one at a time check that the field still has focus,
          // once the keys before are answered, before each space, which could press a button, and
          // after the last key.
          const focusHeld = Guard.check(approval, { focused: true }, flush("type", marks.input));

          if (text === "" && replace && into !== undefined) {
            yield* sameDocument("type", since);
            yield* keyStroke("type", marks.input, ["Delete"]);
          } else {
            const keyed = events.some((event) => event.phase === "down");

            const checks =
              approval !== undefined && keyed ? (text.match(/\s/gu)?.length ?? 0) + 1 : 0;

            // Each check is about two round trips, which only keys typed one at a time need.
            const started = now();

            yield* marks.present((events.at(-1)?.afterMillis ?? 0) + checks * 250);
            for (const event of events) {
              const remaining = started + event.afterMillis - now();

              if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
              if (event.phase === "down" && /\s/u.test(event.key)) yield* focusHeld;
              if (event.phase !== "up") yield* sameDocument("type", since);
              yield* typeEvent(marks.input, event, secret);
            }
            if (keyed) yield* focusHeld;
          }
          // Public Playwright keys preserve platform editing commands. Drain the raw text
          // session before Enter uses Playwright's session, so submit cannot overtake typing.
          yield* flush("type", marks.input);
          if (typeOptions.submit === true) {
            // Typing can move focus or change the form; Enter goes only to the approved field.
            yield* Guard.check(approval, { focused: true });
            yield* sameDocument("type", since);
            const before = mark();

            yield* keyStroke("type", marks.input, ["Enter"]);
            yield* flush("type", marks.input);
            yield* settle("type", before);
          }
        }),
    );
};

const press = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, currentDocument, sameDocument, keyStroke, flush } = input;
  const { mark, settle, targetFor, mutate } = input;

  return (keys: string, pressOptions: PressOptions = {}) =>
    perform(
      "press",
      { target: keys },
      settings.actionTimeout,
      Effect.suspend(() => pressed(keys)).pipe(
        Effect.flatMap((parts) =>
          preparePolicy(
            "press",
            { target: pressOptions.on, text: parts.join("+") },
            [pressOptions.on ?? null],
            { keys: parts.join("+") },
          ),
        ),
      ),
      (marks, approval) =>
        Effect.gen(function* () {
          const parts = yield* pressed(keys);
          const times = Math.max(1, Math.min(50, pressOptions.times ?? 1));
          const hold = pressOptions.holdMillis ?? 0;
          const activates = parts.at(-1) === "Enter" || parts.at(-1) === "Space";
          const since = yield* currentDocument("press");
          const on = pressOptions.on;

          // The keys go to the element asked for, which must hold focus before the first.
          if (on !== undefined) {
            yield* marks.on(yield* targetFor("press", on, approval, marks));

            // Focus handlers may change the page before the protocol reply returns.
            yield* marks.sent;

            const focused = yield* mutate("press", scriptCall("focusOn", on), approval).pipe(
              Effect.flatMap(decodeWith("press", Script.EditResultSchema)),
            );

            if ("error" in focused) return yield* Guard.editFailure("press", on, focused);
            yield* Guard.check(approval, { focused: true });
          }
          const before = mark();
          let due = now();

          yield* marks.sent;
          for (let index = 0; index < times; index++) {
            // A repeated key stays in the document it began in. Under a guard, a repeated Enter
            // or Space must also reach the approved element after the previous press settled.
            if (index > 0 && activates)
              yield* Guard.check(approval, { focused: true }, flush("press", marks.input));
            yield* sameDocument("press", since);
            yield* keyStroke("press", marks.input, parts, hold);
            if (index + 1 < times) {
              const gap = yield* marks.style.keyGap;

              yield* marks.present(gap);
              due += hold + gap;
              if (due > now()) yield* Effect.sleep(Duration.millis(due - now()));
            }
          }
          yield* flush("press", marks.input);
          yield* settle("press", before);
        }),
    );
};

const scroll = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, viewportFor, targetFor, resolve, moveTo, wheel, flush } = input;
  const { mark, settle } = input;

  return (scrollOptions: ScrollOptions = {}) => {
    const target = scrollOptions.at;

    return perform(
      "scroll",
      {
        target: target === undefined ? undefined : named(target),
      },
      settings.actionTimeout,
      preparePolicy("scroll", { target: refOf(target) }, target === undefined ? [] : [target]),
      (marks, approval) =>
        Effect.gen(function* () {
          // Over CDP the page reports its own viewport, so the read shares the action's deadline.
          const viewport = yield* viewportFor("scroll");

          const middle = {
            x: Math.round(viewport.width / 2),
            y: Math.round(viewport.height / 2),
          };

          const dx = scrollOptions.dx ?? 0;

          const dy =
            scrollOptions.dy ??
            (scrollOptions.dx === undefined ? Math.round(viewport.height * 0.8) : 0);

          const steps = yield* marks.style.wheel(dx, dy);

          // A page scroll has no target, but viewers still see the cursor it lands on.
          const resolved =
            target !== undefined
              ? yield* targetFor("scroll", target, approval, marks)
              : marks.style.shown
                ? yield* resolve("scroll", middle, approval).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;

          const point = resolved?.point ?? middle;

          yield* marks.at(point);
          if (target !== undefined && resolved !== undefined) yield* marks.on(resolved);
          yield* moveTo("scroll", marks, point, resolved?.cursor);
          const before = mark();

          yield* marks.sent;
          yield* wheel("scroll", marks, point, dx, dy, steps);
          yield* flush("scroll", marks.input);
          yield* settle("scroll", before);
        }),
    );
  };
};

const select = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, mutate } = input;

  return (ref: string, values: ReadonlyArray<string>) =>
    perform(
      "select",
      { target: ref, text: values.join(", ") },
      settings.actionTimeout,
      preparePolicy("select", { target: ref, text: values.join(", ") }, [ref]),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* marks.on(yield* targetFor("select", ref, approval, marks));

          // The script refuses before it changes anything. Only a choice it made, or a script
          // that may have run without an intact answer, may have reached the page.
          const result = yield* mutate(
            "select",
            scriptCall("select", ref, values),
            approval,
            marks.sent,
          ).pipe(
            Effect.flatMap((value) =>
              decodeWith(
                "select",
                Script.EditResultSchema,
              )(value).pipe(Effect.tapError(() => marks.sent)),
            ),
          );

          if ("error" in result) return yield* Guard.editFailure("select", ref, result);
          yield* marks.sent;

          return result.detail;
        }),
    );
};

export const make = (page: PageContext, bridge: Bridge, viewport: Viewport) => {
  const parts = partsOf(page, bridge, viewport);

  return {
    perform: parts.perform,
    preparePolicy: parts.preparePolicy,
    click: click(parts),
    hover: hover(parts),
    drag: drag(parts),
    type: typeText(parts),
    press: press(parts),
    scroll: scroll(parts),
    select: select(parts),
  };
};

/** A page's input, each action in any style. */
export type Input = ReturnType<typeof make>;
