/**
 * The page's actions: click, hover, drag, type, press, scroll and select, each sent in a style,
 * plainly or performed for viewers, and the aim a performed click starts early. Each runs through
 * `perform`, which admits it, puts it to the input guard and records it. A click, a key or a scroll
 * then waits for the page to settle: a task and a frame, and a document if the input asked for one.
 */
import { Duration, Effect } from "effect";

import { InvalidRequest, NotActionable, StaleRef } from "../../BrowserError.ts";
import type { ClickOptions, PressOptions, ScrollOptions, Target, TypeOptions } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import * as Dispatch from "./dispatch.ts";
import * as Script from "./edit.inpage.ts";
import * as Guard from "./guard.ts";
import * as Keyboard from "./keyboard.ts";
import * as Keys from "./keys.ts";
import * as Perform from "./perform.ts";
import * as Pointer from "./pointer.ts";
import * as Settle from "./settle.ts";
import { plain, type Style } from "./style.ts";
import * as Targets from "./targets.ts";

const buttonMask = { none: 0, left: 1, right: 2, middle: 4 } as const;

const partsOf = (page: PageContext, bridge: Bridge, viewport: Viewport) => {
  const dispatch = Dispatch.make(page);
  const pointer = Pointer.make(page, dispatch, viewport);
  const guard = Guard.make(page, bridge);
  const settling = Settle.make(page, bridge);

  return {
    page,
    bridge,
    ...settling,
    viewportFor: viewport.viewportFor,
    perform: Perform.make(page, dispatch),
    ...guard,
    ...Targets.make(bridge, viewport, guard, pointer, dispatch, settling),
    ...pointer,
    ...Keyboard.make(page, bridge, dispatch),
    sendMouse: dispatch.sendMouse,
    flush: dispatch.flush,
  };
};

type Parts = ReturnType<typeof partsOf>;

/** Whether every number given is finite; a number left out is. */
const finite = (...values: ReadonlyArray<number | undefined>) =>
  values.every((value) => value === undefined || Number.isFinite(value));

const named = (target: Target) => (typeof target === "string" ? target : `${target.x},${target.y}`);

const click = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, moveTo, sendMouse, flush, mark, settle } = input;

  return (target: Target, clickOptions: ClickOptions = {}, style: Style = plain) =>
    perform(
      "click",
      {
        target: named(target),
        options: {
          button: clickOptions.button,
          clickCount: clickOptions.clickCount,
          holdMillis: clickOptions.holdMillis,
        },
      },
      settings.actionTimeout,
      Effect.suspend(() =>
        finite(clickOptions.clickCount, clickOptions.holdMillis)
          ? preparePolicy("click", { target: typeof target === "string" ? target : undefined }, [
              target,
            ])
          : failWith(
              "click",
              new InvalidRequest({ detail: "clickCount and holdMillis must be finite" }),
            ),
      ),
      (marks, approval) =>
        Effect.gen(function* () {
          if (!finite(clickOptions.clickCount, clickOptions.holdMillis))
            return yield* failWith(
              "click",
              new InvalidRequest({ detail: "clickCount and holdMillis must be finite" }),
            );
          const resolved = yield* targetFor("click", target, approval, marks);
          const { point } = resolved;
          const button = clickOptions.button ?? "left";
          const count = Math.max(1, Math.min(3, clickOptions.clickCount ?? 1));

          yield* marks.at(point);
          yield* marks.on(resolved);
          yield* moveTo("click", marks, point, resolved.cursor);
          if (approval !== undefined) yield* approval.check({ presses: [{ index: 0, ...point }] });
          const before = mark();

          yield* marks.sent;
          for (let index = 1; index <= count; index++) {
            // An earlier click of a multi-click can replace the approved control under the
            // pointer. Under a guard, its handlers run before the next press is checked and sent.
            if (approval !== undefined && index > 1) {
              yield* flush("click", marks.input);
              yield* approval.check({ presses: [{ index: 0, ...point }] }).pipe(
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
            }
            yield* sendMouse("click", marks.input, {
              type: "mousePressed",
              ...point,
              button,
              buttons: buttonMask[button],
              clickCount: index,
            });

            // A hold the caller asks for is the click's own; the style's is presentation.
            const hold = clickOptions.holdMillis ?? (yield* marks.style.hold);

            if (clickOptions.holdMillis === undefined) yield* marks.present(hold);
            if (hold > 0) yield* Effect.sleep(Duration.millis(hold));
            yield* sendMouse("click", marks.input, {
              type: "mouseReleased",
              ...point,
              button,
              buttons: 0,
              clickCount: index,
            });
          }
          yield* flush("click", marks.input);
          yield* settle("click", before);

          return resolved;
        }),
      style,
    );
};

const hover = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, moveTo, flush } = input;

  return (target: Target, style: Style = plain) =>
    perform(
      "hover",
      { target: named(target) },
      settings.actionTimeout,
      preparePolicy("hover", { target: typeof target === "string" ? target : undefined }, [target]),
      (marks, approval) =>
        Effect.gen(function* () {
          const resolved = yield* targetFor("hover", target, approval, marks);
          const { point } = resolved;

          yield* marks.at(point);
          yield* marks.on(resolved);
          yield* moveTo("hover", marks, point, resolved.cursor, "hover");
          yield* flush("hover", marks.input);
        }),
      style,
    );
};

/**
 * The pointer's travel to a target, before its action is asked: no guard holds it, no action is
 * recorded, and nothing is pressed. A guarded page aims nothing, as its input waits for approval.
 */
const aim = (input: Parts) => {
  const { settings } = input.page;
  const { perform, targetFor, moveTo, flush } = input;

  return (target: Target, style: Style) =>
    settings.guard === undefined
      ? perform(
          "aim",
          { target: named(target), recorded: false },
          settings.actionTimeout,
          Effect.die("an aim is never put to a guard"),
          (marks) =>
            targetFor("aim", target, undefined, marks).pipe(
              Effect.flatMap(({ point, cursor }) => moveTo("aim", marks, point, cursor)),
              Effect.andThen(flush("aim", marks.input)),
            ),
          style,
        )
      : Effect.void;
};

const drag = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, resolve, moveTo, sendMouse, flush } = input;

  return (from: Target, to: Target, style: Style = plain) =>
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
          if (approval !== undefined)
            yield* approval.check({
              presses: [
                { index: 0, ...start.point },
                { index: 1, ...end.point },
              ],
            });
          yield* marks.sent;
          yield* sendMouse("drag", marks.input, {
            type: "mousePressed",
            ...start.point,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          yield* moveTo("drag", marks, end.point, end.cursor, "drag");
          yield* sendMouse("drag", marks.input, {
            type: "mouseReleased",
            ...end.point,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          yield* flush("drag", marks.input);
        }),
      style,
    );
};

const typeText = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, mutate, targetFor, moveTo, sendMouse, flush, bridge } = input;
  const { currentDocument, sameDocument, keyStroke, typeEvent, mark, settle } = input;

  return (text: string, typeOptions: TypeOptions = {}, style: Style = plain) =>
    perform(
      "type",
      {
        target: typeOptions.into,
        options: { replace: typeOptions.replace, submit: typeOptions.submit },
        text,
        secret: true,
      },
      settings.actionTimeout,
      preparePolicy("type", { target: typeOptions.into, text }, [typeOptions.into ?? null], {
        submit: typeOptions.submit ?? false,
      }),
      (marks, approval) =>
        Effect.gen(function* () {
          const replace = typeOptions.replace ?? true;
          const into = typeOptions.into;

          if (into !== undefined && !/^e\d+$/.test(into))
            return yield* failWith(
              "type",
              new InvalidRequest({ detail: `"${into}" is not a ref; refs look like e12` }),
            );

          // A typed space or letter can press a focused button or change a control. Refuse
          // those before any input, on every path.
          const asked = scriptCall("typeable", into ?? null, typeOptions.secret === true);

          const typeable = yield* (
            approval === undefined
              ? bridge.evaluate("type", asked)
              : mutate("type", asked, approval)
          ).pipe(Effect.flatMap(decodeWith("type", Script.TypeableResultSchema)));

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
              if (approval !== undefined)
                yield* approval.check({ presses: [{ index: 0, ...target.point }] });
              yield* marks.sent;
              for (const type of ["mousePressed", "mouseReleased"] as const)
                yield* sendMouse("type", marks.input, {
                  type,
                  ...target.point,
                  button: "left",
                  buttons: type === "mousePressed" ? 1 : 0,
                  clickCount: 1,
                });
              yield* flush("type", marks.input);
            }

            // Focusing can run page handlers, including navigation, before the script returns.
            yield* marks.sent;

            const focused = yield* mutate(
              "type",
              scriptCall("focus", into, replace),
              approval,
            ).pipe(Effect.flatMap(decodeWith("type", Script.FocusResultSchema)));

            if ("error" in focused) return yield* Guard.editFailure("type", into, focused);
            secret ||= focused.secret;
          }
          if (!secret) yield* marks.reveal;
          if (approval !== undefined) yield* approval.check({ focused: true });
          yield* marks.sent;

          // A key's handlers can move focus, and later keys then reach a control nobody approved.
          // Under a guard, the field is approved once: plain text goes in one insertion, which no
          // handler can split, and keys typed one at a time check that the field still has focus,
          // once the keys before are answered, before each space, which could press a button, and
          // after the last key.
          const focusHeld =
            approval === undefined
              ? Effect.void
              : flush("type", marks.input).pipe(Effect.andThen(approval.check({ focused: true })));

          if (text === "" && replace && into !== undefined) {
            yield* sameDocument("type", since);
            yield* keyStroke("type", marks.input, ["Delete"]);
          } else {
            const events = yield* marks.style.typing(text, approval !== undefined);
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
            if (approval !== undefined) yield* approval.check({ focused: true });
            yield* sameDocument("type", since);
            const before = mark();

            yield* keyStroke("type", marks.input, ["Enter"]);
            yield* flush("type", marks.input);
            yield* settle("type", before);
          }
        }),
      style,
    );
};

const press = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, currentDocument, sameDocument, keyStroke, flush } = input;
  const { mark, settle } = input;

  return (keys: string, pressOptions: PressOptions = {}, style: Style = plain) =>
    perform(
      "press",
      { target: keys, options: { times: pressOptions.times, holdMillis: pressOptions.holdMillis } },
      settings.actionTimeout,
      Effect.suspend(() => {
        if (!finite(pressOptions.times, pressOptions.holdMillis))
          return failWith(
            "press",
            new InvalidRequest({ detail: "times and holdMillis must be finite" }),
          );
        const combination = Keys.normalize(keys);

        return combination === undefined
          ? failWith(
              "press",
              new InvalidRequest({
                detail: `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`,
              }),
            )
          : preparePolicy("press", { text: combination }, [null], { keys: combination });
      }),
      (marks, approval) =>
        Effect.gen(function* () {
          if (!finite(pressOptions.times, pressOptions.holdMillis))
            return yield* failWith(
              "press",
              new InvalidRequest({ detail: "times and holdMillis must be finite" }),
            );
          const parts = Keys.parts(keys);

          if (parts === undefined)
            return yield* failWith(
              "press",
              new InvalidRequest({
                detail: `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`,
              }),
            );
          const times = Math.max(1, Math.min(50, pressOptions.times ?? 1));
          const hold = pressOptions.holdMillis ?? 0;
          const activates = parts.at(-1) === "Enter" || parts.at(-1) === "Space";
          const since = yield* currentDocument("press");
          const before = mark();
          let due = now();

          yield* marks.sent;
          for (let index = 0; index < times; index++) {
            // A repeated key stays in the document it began in. Under a guard, a repeated Enter
            // or Space must also reach the approved element after the previous press settled.
            if (index > 0 && approval !== undefined && activates) {
              yield* flush("press", marks.input);
              yield* approval.check({ focused: true });
            }
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
      style,
    );
};

const scroll = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, viewportFor, targetFor, resolve, moveTo, wheel, flush } = input;
  const { mark, settle } = input;

  return (scrollOptions: ScrollOptions = {}, style: Style = plain) => {
    const target = scrollOptions.at;

    const valid =
      Number.isFinite(scrollOptions.dx ?? 0) && Number.isFinite(scrollOptions.dy ?? 0)
        ? Effect.void
        : failWith("scroll", new InvalidRequest({ detail: "scroll deltas must be finite" }));

    return perform(
      "scroll",
      {
        target: target === undefined ? undefined : named(target),
        options: { dx: scrollOptions.dx, dy: scrollOptions.dy },
      },
      settings.actionTimeout,
      valid.pipe(
        Effect.andThen(
          // Scrolling the page has no target: whatever sits mid-viewport is not what is scrolled.
          preparePolicy(
            "scroll",
            { target: typeof target === "string" ? target : undefined },
            target === undefined ? [] : [target],
          ),
        ),
      ),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* valid;
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
          yield* wheel("scroll", marks, point, dx, dy);
          yield* flush("scroll", marks.input);
          yield* settle("scroll", before);
        }),
      style,
    );
  };
};

const select = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, mutate } = input;

  return (ref: string, values: ReadonlyArray<string>) =>
    perform(
      "select",
      { target: ref, options: { values }, text: values.join(", ") },
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
    aim: aim(parts),
    drag: drag(parts),
    type: typeText(parts),
    press: press(parts),
    scroll: scroll(parts),
    select: select(parts),
  };
};

/** A page's input, each action in any style. */
export type Input = ReturnType<typeof make>;
