/**
 * The pointer's travel and the wheel. Travel follows a motion plan, published before its first
 * move, and a wheel scroll can be split into paced steps.
 */
import { Duration, Effect, Option, Ref, Schema } from "effect";

import { InvalidRequest } from "../../BrowserError.ts";
import { CursorChanged, TrackPerformed, TrackPlanned } from "../../BrowserEvent.ts";
import * as Motion from "../../Motion.ts";
import type { Point } from "../../Page.ts";
import { failWith, type PageContext } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import type { Dispatch } from "./dispatch.ts";
import * as Human from "./human.ts";
import type { InputMarks } from "./perform.ts";
import type * as Replies from "./replies.ts";

export const make = (page: PageContext, dispatch: Dispatch, viewport: Viewport) => {
  const { id, settings, motion, pointer, publish, now, span } = page;
  const { inputClocks, inputCall, dispatchMouse, sendMouse } = dispatch;

  // Travel toward a press only prepares the action; a hover is its travel, and a drag holds the
  // button it has already pressed.
  const moveTo = (
    operation: string,
    marks: InputMarks,
    to: Point,
    cursor?: string,
    travel: "approach" | "hover" | "drag" = "approach",
  ) =>
    Effect.gen(function* () {
      const dragging = travel === "drag";
      const size = yield* viewport.viewportFor(operation);

      const previous = Option.getOrElse(yield* Ref.get(pointer), () => ({
        x: Math.round(size.width / 2),
        y: Math.round(size.height / 2),
      }));

      const from = {
        x: Math.max(0, Math.min(size.width - 1, previous.x)),
        y: Math.max(0, Math.min(size.height - 1, previous.y)),
      };

      const planned = settings.humanize
        ? yield* motion.plan(from, to)
        : dragging
          ? Array.from({ length: 8 }, (_, index) => ({
              x: index === 7 ? to.x : from.x + ((to.x - from.x) * (index + 1)) / 8,
              y: index === 7 ? to.y : from.y + ((to.y - from.y) * (index + 1)) / 8,
              afterMillis: (index + 1) * 8,
            }))
          : [{ ...to, afterMillis: 0 }];

      // A custom planner is a boundary. Decoding reads each sample once into a fresh copy and
      // checks that copy, so neither accessors nor later mutation can change what is admitted.
      const invalid = failWith(
        operation,
        new InvalidRequest({
          detail: "motion must be a bounded, ordered schedule ending at the target",
        }),
      );

      const samples = yield* Schema.decodeEffect(Motion.Plan)(planned).pipe(
        Effect.catch(() => invalid),
      );

      if (samples.at(-1)?.x !== to.x || samples.at(-1)?.y !== to.y) return yield* invalid;
      yield* Effect.annotateCurrentSpan("samples", samples.length);
      const run = marks.input;

      // Admit the whole motion before starting its clock. Dense original samples must not be
      // stretched by per-sample reply backpressure; unsent reservations belong to this run.
      yield* inputCall(operation, run.reserveMotion(samples.length));
      yield* Ref.set(pointer, Option.some(from));
      const estimate = inputClocks.get(run);
      const at = now();
      let dispatched = 0;
      let last = from;

      // The complete plan exists before its first move. A canceled performer always clips
      // that future to the prefix it actually submitted, including interruption during sleep.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => publish(new TrackPlanned({ at, page: id, from, samples }))),
        () =>
          Effect.gen(function* () {
            for (const sample of samples) {
              const remaining = at + sample.afterMillis - now();

              if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
              yield* travel === "approach" ? marks.touched : marks.sent;
              yield* inputCall(
                operation,
                run.send(() =>
                  dispatchMouse(
                    {
                      type: "mouseMoved",
                      x: sample.x,
                      y: sample.y,
                      button: dragging ? "left" : "none",
                      ...(dragging ? { buttons: 1 } : {}),
                    },
                    estimate,
                    () => {
                      dispatched++;
                      last = { x: sample.x, y: sample.y };
                      if (dispatched === samples.length && cursor !== undefined)
                        publish(new CursorChanged({ at: now(), page: id, cursor }));
                    },
                  ),
                ),
              );
            }
          }),
        (plan) =>
          Effect.sync(() =>
            publish(
              new TrackPerformed({
                at: now(),
                page: id,
                plan,
                dispatched,
                ...last,
                complete: dispatched === samples.length,
              }),
            ),
          ),
      );
    }).pipe(span("Page.move", {}, "Debug"));

  const wheel = Effect.fnUntraced(function* (
    operation: string,
    run: Replies.Run,
    point: Point,
    dx: number,
    dy: number,
  ) {
    const steps = settings.humanize
      ? Math.max(1, Math.min(8, Math.round(Math.hypot(dx, dy) / 120)))
      : 1;

    for (let index = 0; index < steps; index++) {
      if (index > 0) yield* Effect.sleep(Duration.millis(yield* Human.pause("scroll")));
      yield* sendMouse(operation, run, {
        type: "mouseWheel",
        ...point,
        deltaX: dx / steps,
        deltaY: dy / steps,
      });
    }
  });

  return { moveTo, wheel };
};

export type Pointer = ReturnType<typeof make>;
