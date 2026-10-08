/**
 * The pointer's travel and the wheel, as the action's style sends them. Travel follows a motion
 * plan, published before its first move, from where viewers last saw the pointer when it is
 * shown, and a wheel scroll goes in the style's steps.
 */
import { Duration, Effect, MutableRef, Option, Schema } from "effect";

import { InvalidRequest } from "../../BrowserError.ts";
import { CursorChanged, TrackPerformed, TrackPlanned } from "../../BrowserEvent.ts";
import * as Motion from "../../Motion.ts";
import type { Point } from "../../Page.ts";
import { failWith, type PageContext } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import type { Dispatch } from "./dispatch.ts";
import type { InputMarks } from "./perform.ts";

export const make = (page: PageContext, dispatch: Dispatch, viewport: Viewport) => {
  const { id, pointer, publish, now, span } = page;
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
      const { style } = marks;
      const drawn = style.pointer ?? pointer;
      const size = yield* viewport.viewportFor(operation);

      const previous = Option.getOrElse(MutableRef.get(drawn), () => ({
        x: Math.round(size.width / 2),
        y: Math.round(size.height / 2),
      }));

      const from = {
        x: Math.max(0, Math.min(size.width - 1, previous.x)),
        y: Math.max(0, Math.min(size.height - 1, previous.y)),
      };

      const planned = yield* style.glide(from, to, dragging);

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
      yield* marks.present(samples.at(-1)?.afterMillis ?? 0);
      const run = marks.input;

      // Admit the whole motion before starting its clock. Dense original samples must not be
      // stretched by per-sample reply backpressure; unsent reservations belong to this run.
      yield* inputCall(operation, run.reserveMotion(samples.length));
      MutableRef.set(pointer, Option.some(from));
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
                      MutableRef.set(drawn, Option.some(last));
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
    marks: InputMarks,
    point: Point,
    dx: number,
    dy: number,
  ) {
    const steps = yield* marks.style.wheel(dx, dy);
    const at = now();

    yield* marks.present(steps.at(-1)?.afterMillis ?? 0);
    for (const step of steps) {
      const remaining = at + step.afterMillis - now();

      if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
      yield* sendMouse(operation, marks.input, {
        type: "mouseWheel",
        ...point,
        deltaX: step.dx,
        deltaY: step.dy,
      });
    }
  });

  return { moveTo, wheel };
};

export type Pointer = ReturnType<typeof make>;
