import { Duration, Effect } from "effect";
import type { AnySession } from "effect-browser/browser";
import {
  ClickRequest,
  type InputReceipt,
  PointerMoveRequest,
  PressRequest,
  TypeRequest,
} from "effect-browser/browser-data";

import { type Answer, Report } from "./Cues.ts";
import { type CueRequest, Director } from "./Director.ts";
import { FootageError } from "./FootageError.ts";
import * as Humanize from "./Humanize.ts";
import { Telemetry } from "./Telemetry.ts";

/**
 * What a person at the keyboard does, built from two kinds of step.
 *
 * Presentation (where the pointer travels, how the page scrolls) is cued to
 * the stagehand and changes nothing. Every change to the page is one of the
 * session's own bounded actions, dispatched only after the pointer has visibly
 * arrived. The footage therefore shows the same clicks and keys an unfilmed
 * run would make, no more and no fewer.
 */

type Located = Extract<Answer, { readonly _tag: "Located" }>;

/** Where on screen a person likes the thing they are about to use. */
const Comfort = { top: 0.18, bottom: 0.72, settle: 0.42 } as const;

const cue = <Tag extends Answer["_tag"]>(request: CueRequest, expected: Tag) =>
  Effect.gen(function* () {
    const director = yield* Director;
    const answer = yield* director.perform(request);

    if (Report.guards[expected](answer)) return answer;

    return yield* FootageError.make({
      reason: answer._tag === "Missing" ? "target-missing" : "unexpected-report",
      detail: "selector" in request ? request.selector : request._tag,
    });
  });

/** A `Locate` plays nothing, so its duration is the page-to-host channel's round trip. */
const locate = Effect.fnUntraced(function* (selector: string) {
  const telemetry = yield* Telemetry;
  const [duration, found] = yield* Effect.timed(cue({ _tag: "Locate", selector }, "Located"));

  yield* telemetry.cueRoundTrip(Duration.toMillis(duration));

  return found;
});

/** The session's own action, timed around the call: admission, dispatch and return. */
const timed = <A, E, R>(kind: string, action: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.action(kind, action));

/** Native input reports its own interval, around the native command alone. */
const received = <E, R>(kind: string, input: Effect.Effect<InputReceipt, E, R>) =>
  Effect.flatMap(Telemetry, (telemetry) => telemetry.input(kind, input));

/** Scroll until the target sits where a reader would want it, then report where that is. */
const bringIntoView = Effect.fn("Actor.bringIntoView")(function* (selector: string) {
  const found = yield* locate(selector);
  const { viewport, scroll } = found.stage;
  const centre = found.box.y + found.box.height / 2;

  if (centre >= viewport.height * Comfort.top && centre <= viewport.height * Comfort.bottom)
    return found;

  const wanted = scroll.top + centre - viewport.height * Comfort.settle;
  const top = Math.min(scroll.maximumTop, Math.max(0, wanted));

  if (Math.abs(top - scroll.top) < 1) return found;

  yield* cue({ _tag: "Scroll", track: yield* Humanize.scrollTrack(scroll.top, top) }, "Played");

  return yield* locate(selector);
});

/**
 * The drawn pointer travels the whole path in the page; the real one joins it
 * where it lands, in one native move. The page then sees a trusted pointer at
 * the aim point, so `:hover` applies before the press as it would for a person.
 * Sending every sample of the path as its own native move would film the
 * round trip instead of the motion.
 */
const glideOnto = Effect.fnUntraced(function* (session: AnySession, found: Located) {
  const aim = yield* Humanize.aimPoint(found.box);

  const path = yield* Humanize.pointerPath(
    found.stage.pointer,
    aim,
    Math.min(found.box.width, found.box.height),
  );

  yield* cue({ _tag: "Glide", path }, "Played");

  yield* received(
    "pointerMove",
    session.pointerMove(
      PointerMoveRequest.make({ to: { x: Math.max(0, aim.x), y: Math.max(0, aim.y) } }),
    ),
  );
});

export const scrollTo = (selector: string) => Effect.asVoid(bringIntoView(selector));

export const moveTo = Effect.fn("Actor.moveTo")(function* (session: AnySession, selector: string) {
  yield* glideOnto(session, yield* bringIntoView(selector));
});

/** Arrive, settle, then let the session press: the ripple is drawn from its real event. */
const press = <A, E, R>(session: AnySession, selector: string, action: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* moveTo(session, selector);
    yield* Effect.sleep(yield* Humanize.between(Humanize.Pacing.dwellBeforeClickMillis));
    const result = yield* action;

    yield* Effect.sleep(yield* Humanize.between(Humanize.Pacing.afterClickMillis));

    return result;
  });

export const click = Effect.fn("Actor.click")(function* (session: AnySession, selector: string) {
  return yield* press(
    session,
    selector,
    timed("click", session.click(ClickRequest.make({ selector }))),
  );
});

/**
 * A click that loads another document. The camera follows the page across it,
 * so the loading is on film, and the new document is not acted on until it
 * reports ready.
 */
export const follow = Effect.fn("Actor.follow")(function* (session: AnySession, selector: string) {
  const result = yield* press(
    session,
    selector,
    timed("clickAndWait", session.clickAndWait(ClickRequest.make({ selector }))),
  );

  yield* session.ready;

  return result;
});

/**
 * Real keys, one at a time at a typist's cadence, so the page sees what it
 * would from a keyboard: a key event each way for every character, and a slip
 * taken back with Backspace. The click is what gives the field focus. Every key
 * is then sent `into` that field, so one that lost focus halfway receives
 * nothing rather than letting the rest land somewhere else. Shift is really
 * held for a capital, since a page can read the modifier. Each key is one
 * action against the policy's budget.
 */
export const type = Effect.fn("Actor.type")(function* (
  session: AnySession,
  selector: string,
  text: string,
) {
  yield* click(session, selector);

  for (const stroke of yield* Humanize.keystrokes(text)) {
    yield* Effect.sleep(stroke.afterMillis);
    yield* received(
      "key",
      stroke._tag === "Backspace"
        ? session.press(PressRequest.make({ key: "Backspace", into: selector }))
        : Humanize.needsShift(stroke.character)
          ? session.press(
              PressRequest.make({ key: stroke.character, modifiers: ["Shift"], into: selector }),
            )
          : session.type(TypeRequest.make({ text: stroke.character, into: selector })),
    );
  }
});

/** Rest on what just appeared for as long as it takes to skim it. */
export const read = (words: number) => Effect.sleep(Humanize.readingMillis(words));

export const caption = (text: string) => Effect.asVoid(cue({ _tag: "Caption", text }, "Played"));
