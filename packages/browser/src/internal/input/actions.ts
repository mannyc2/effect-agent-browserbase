/**
 * The page's actions: click, hover, drag, type, press, scroll and select. Each runs through
 * `perform`, which admits it, puts it to the input guard and records it.
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
import * as Human from "./human.ts";
import * as Keyboard from "./keyboard.ts";
import * as Keys from "./keys.ts";
import * as Perform from "./perform.ts";
import * as Pointer from "./pointer.ts";
import * as Targets from "./targets.ts";

const buttonMask = { none: 0, left: 1, right: 2, middle: 4 } as const;

// Under a guard, each key after the first waits for the earlier keys' answers and a focus check,
// about two protocol round trips, so the typing deadline allows this much more per key.
const guardedKeyMillis = 250;

const presentationPause = (page: PageContext) => (kind: "action" | "focus") =>
  page.settings.humanize
    ? Human.pause(kind).pipe(Effect.flatMap((millis) => Effect.sleep(Duration.millis(millis))))
    : Effect.void;

// Give a navigation the input started a moment to begin, then wait for its document.
// Presentation randomness supplements this floor; it can never shorten readiness.
const settle = (page: PageContext) =>
  Effect.sleep(Duration.millis(page.settings.humanize ? 250 : 120)).pipe(
    Effect.andThen(
      Effect.tryPromise(() =>
        page.playwright.waitForLoadState("domcontentloaded", { timeout: 5_000 }),
      ).pipe(
        // A document still loading after 5 seconds, or a closed page, is the next look's to show.
        Effect.catch(() => Effect.annotateCurrentSpan("loaded", false)),
      ),
    ),
    Effect.andThen(presentationPause(page)("action")),
    page.span("Page.settle", {}, "Debug"),
  );

const partsOf = (page: PageContext, bridge: Bridge, viewport: Viewport) => {
  const dispatch = Dispatch.make(page);
  const pointer = Pointer.make(page, dispatch, viewport);
  const guard = Guard.make(page, bridge);

  return {
    page,
    evaluate: bridge.evaluate,
    viewportFor: viewport.viewportFor,
    perform: Perform.make(page, dispatch),
    ...guard,
    ...Targets.make(page, bridge, viewport, guard, pointer, dispatch),
    ...pointer,
    ...Keyboard.make(page, dispatch),
    sendMouse: dispatch.sendMouse,
    flush: dispatch.flush,
    settle: settle(page),
    presentationPause: presentationPause(page),
  };
};

type Parts = ReturnType<typeof partsOf>;

/** Whether every number given is finite; a number left out is. */
const finite = (...values: ReadonlyArray<number | undefined>) =>
  values.every((value) => value === undefined || Number.isFinite(value));

const click = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, targetFor, moveTo, sendMouse, flush, settle } = input;

  return (target: Target, clickOptions: ClickOptions = {}) =>
    perform(
      "click",
      {
        target: typeof target === "string" ? target : `${target.x},${target.y}`,
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

            const hold =
              clickOptions.holdMillis ?? (settings.humanize ? yield* Human.pressDelay : 0);

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
          yield* settle;

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
      { target: typeof target === "string" ? target : `${target.x},${target.y}` },
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
    );
};

const typeText = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, evaluate, mutate, targetFor, moveTo, sendMouse, flush } = input;
  const { currentDocument, sameDocument, keyStroke, typeEvent, settle, presentationPause } = input;

  return (text: string, typeOptions: TypeOptions = {}) =>
    perform(
      "type",
      {
        target: typeOptions.into,
        options: {
          replace: typeOptions.replace,
          submit: typeOptions.submit,
          prose: typeOptions.prose,
        },
        text,
        secret: true,
      },
      Duration.sum(
        settings.actionTimeout,
        Duration.millis(
          (settings.humanize ? Human.typingDuration(text) : 0) +
            (settings.guard === undefined ? 0 : guardedKeyMillis * text.length),
        ),
      ),
      preparePolicy("type", { target: typeOptions.into, text }, [typeOptions.into ?? null], {
        submit: typeOptions.submit ?? false,
      }),
      (marks, approval) =>
        Effect.gen(function* () {
          const replace = typeOptions.replace ?? true;
          const into = typeOptions.into;
          let corrected = false;
          let eligible = false;

          if (into !== undefined && !/^e\d+$/.test(into))
            return yield* failWith(
              "type",
              new InvalidRequest({ detail: `"${into}" is not a ref; refs look like e12` }),
            );

          // A typed space or letter can press a focused button or change a control. Refuse
          // those before any input, on every path.
          const typeable = yield* (
            approval === undefined
              ? evaluate("type", scriptCall("typeable", into ?? null))
              : mutate("type", scriptCall("typeable", into ?? null), approval)
          ).pipe(Effect.flatMap(decodeWith("type", Script.TypeableResultSchema)));

          if ("error" in typeable)
            return yield* failWith(
              "type",
              typeable.error === "stale" && into !== undefined
                ? new StaleRef({ ref: into })
                : new NotActionable({ detail: typeable.detail }),
            );

          const since = yield* currentDocument("type");
          let secret = typeable.secret;

          if (into !== undefined) {
            const ref = into;
            const target = yield* targetFor("type", ref, approval, marks);

            yield* marks.at(target.point);
            yield* marks.on(target);
            if (settings.humanize) {
              yield* moveTo("type", marks, target.point, target.cursor);
              if (approval !== undefined)
                yield* approval.check({ presses: [{ index: 0, ...target.point }] });
              yield* marks.sent;
              yield* sendMouse("type", marks.input, {
                type: "mousePressed",
                ...target.point,
                button: "left",
                buttons: 1,
                clickCount: 1,
              });
              yield* sendMouse("type", marks.input, {
                type: "mouseReleased",
                ...target.point,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
              yield* flush("type", marks.input);
            }

            // Focusing can run page handlers, including navigation, before the script returns.
            yield* marks.sent;

            const focused = yield* mutate("type", scriptCall("focus", ref, replace), approval).pipe(
              Effect.flatMap(decodeWith("type", Script.FocusResultSchema)),
            );

            if ("error" in focused) return yield* Guard.editFailure("type", ref, focused);
            eligible = focused.prose;
            secret ||= focused.secret;
          }
          if (!secret) yield* marks.reveal;
          yield* presentationPause("focus");
          if (approval !== undefined) yield* approval.check({ focused: true });
          yield* marks.sent;

          // A key's handlers can move focus, and later keys then reach a control nobody approved.
          // Under a guard, the earlier keys are answered and focus is checked before each further
          // key, so no key goes to another control.
          let keys = 0;

          const beforeKey = Effect.gen(function* () {
            if (approval !== undefined && keys > 0) yield* flush("type", marks.input);
            yield* sameDocument("type", since);
            if (approval !== undefined && keys > 0) yield* approval.check({ focused: true });
            keys += 1;
          });

          if (text === "" && replace && typeOptions.into !== undefined) {
            yield* sameDocument("type", since);
            yield* keyStroke("type", marks.input, ["Delete"]);
          } else {
            // Separate down/up deadlines permit overlapping holds without adding one hold to
            // every inter-key gap. The same bounded run owns all releases and interruptions.
            if (settings.humanize) {
              const prose =
                typeOptions.prose === true &&
                typeOptions.into !== undefined &&
                replace &&
                eligible &&
                !/\d|@|[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[a-z\d-]+\.[a-z]{2,}\b/i.test(text);

              const plan = yield* Human.typing(text, { prose });

              corrected = plan.events.some((event) => event.key === "Backspace");
              const started = now();

              for (const event of plan.events) {
                yield* Effect.sleep(
                  Duration.millis(Math.max(0, started + event.afterMillis - now())),
                );
                if (event.phase !== "up") yield* beforeKey;
                yield* typeEvent(marks.input, event, secret);
              }
            } else {
              for (const character of text) {
                yield* beforeKey;
                if (Keys.description(character) === undefined)
                  yield* typeEvent(marks.input, { phase: "insert", key: character }, secret);
                else {
                  yield* typeEvent(marks.input, { phase: "down", key: character }, secret);
                  yield* typeEvent(marks.input, { phase: "up", key: character }, secret);
                }
              }
            }
          }
          // Public Playwright keys preserve platform editing commands. Drain the raw text
          // session before Enter uses Playwright's session, so submit cannot overtake typing.
          yield* flush("type", marks.input);
          if (corrected && typeOptions.into !== undefined) {
            const checked = yield* mutate(
              "type",
              scriptCall("checkText", typeOptions.into, text),
              approval,
            ).pipe(Effect.flatMap(decodeWith("type", Script.EditResultSchema)));

            if ("error" in checked)
              return yield* Guard.editFailure("type", typeOptions.into, checked);
          }
          if (typeOptions.submit === true) {
            // Typing can move focus or change the form; Enter goes only to the approved field.
            if (approval !== undefined) yield* approval.check({ focused: true });
            yield* sameDocument("type", since);
            yield* keyStroke("type", marks.input, ["Enter"]);
            yield* flush("type", marks.input);
            yield* settle;
          }
        }),
    );
};

const press = (input: Parts) => {
  const { settings, now } = input.page;
  const { perform, preparePolicy, currentDocument, sameDocument, keyStroke, flush, settle } = input;

  return (keys: string, pressOptions: PressOptions = {}) =>
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
            if (index + 1 < times && settings.humanize) {
              due += hold + (yield* Human.keyDelay);
              yield* Effect.sleep(Duration.millis(Math.max(0, due - now())));
            }
          }
          yield* flush("press", marks.input);
          yield* settle;
        }),
    );
};

const scroll = (input: Parts) => {
  const { settings } = input.page;
  const { perform, preparePolicy, viewportFor, targetFor, resolve, moveTo, wheel, flush } = input;
  const { presentationPause } = input;

  return (scrollOptions: ScrollOptions = {}) => {
    const target = scrollOptions.at;

    const valid =
      Number.isFinite(scrollOptions.dx ?? 0) && Number.isFinite(scrollOptions.dy ?? 0)
        ? Effect.void
        : failWith("scroll", new InvalidRequest({ detail: "scroll deltas must be finite" }));

    return perform(
      "scroll",
      {
        target:
          scrollOptions.at === undefined
            ? undefined
            : typeof scrollOptions.at === "string"
              ? scrollOptions.at
              : `${scrollOptions.at.x},${scrollOptions.at.y}`,
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

          // A page scroll has no target, but a visible pointer still shows the cursor it lands on.
          const resolved =
            target !== undefined
              ? yield* targetFor("scroll", target, approval, marks)
              : settings.humanize
                ? yield* resolve("scroll", middle, approval).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;

          const point = resolved?.point ?? middle;

          yield* marks.at(point);
          if (target !== undefined && resolved !== undefined) yield* marks.on(resolved);
          yield* moveTo("scroll", marks, point, resolved?.cursor);
          yield* marks.sent;
          yield* wheel("scroll", marks.input, point, dx, dy);
          yield* flush("scroll", marks.input);
          yield* Effect.sleep(Duration.millis(150));
          yield* presentationPause("action");
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
    drag: drag(parts),
    type: typeText(parts),
    press: press(parts),
    scroll: scroll(parts),
    select: select(parts),
  };
};
