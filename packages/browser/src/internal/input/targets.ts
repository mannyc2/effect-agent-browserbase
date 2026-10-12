/**
 * Where an action's input goes: a ref or a point resolved to a control and a viewport point,
 * scrolled into view first when it is outside the viewport: at once, or with the wheel where
 * viewers watch.
 */
import { Effect } from "effect";

import { InvalidRequest, NotActionable, StaleRef } from "../../BrowserError.ts";
import { ResolvedTarget, type Target } from "../../Page.ts";
import { scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, refuse } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import type { Dispatch } from "./dispatch.ts";
import { type Approval, check, type Guard } from "./guard.ts";
import type { InputMarks } from "./perform.ts";
import type { Pointer } from "./pointer.ts";
import type { Settle } from "./settle.ts";
import * as Script from "./targets.inpage.ts";

const pointFailure = (
  operation: string,
  target: Target,
  result: Extract<Script.PointResult, { readonly error: string }>,
) =>
  failWith(
    operation,
    result.error === "stale" && typeof target === "string"
      ? new StaleRef({ ref: target })
      : result.error === "outside"
        ? new InvalidRequest({ detail: result.detail })
        : new NotActionable({ detail: result.detail }),
  );

const resolvedTarget = ({ x, y, box, ...target }: Script.ResolvedPoint): ResolvedTarget =>
  new ResolvedTarget({ point: { x, y }, box, ...target });

export const make = (
  viewport: Viewport,
  guard: Guard,
  pointer: Pointer,
  dispatch: Dispatch,
  settling: Settle,
) => {
  const { evaluate, mutate } = guard;
  const { moveTo, wheel } = pointer;
  const { flush } = dispatch;

  const readPoint = (
    operation: string,
    target: Target,
    approval: Approval | undefined,
    scroll: boolean,
  ) =>
    evaluate(operation, scriptCall("point", target, scroll), approval).pipe(
      Effect.flatMap(decodeWith(operation, Script.PointResultSchema)),
    );

  const resolve = (operation: string, target: Target, approval?: Approval, scroll = true) => {
    if (typeof target === "string" && !/^e\d+$/.test(target))
      return refuse(operation, target + " is not a ref; refs look like e12");
    if (typeof target !== "string" && (!Number.isFinite(target.x) || !Number.isFinite(target.y)))
      return refuse(operation, "point coordinates must be finite");

    return readPoint(operation, target, approval, scroll).pipe(
      Effect.flatMap((result) =>
        "error" in result
          ? pointFailure(operation, target, result)
          : Effect.succeed(resolvedTarget(result)),
      ),
    );
  };

  const targetFor = Effect.fnUntraced(function* (
    operation: string,
    target: Target,
    approval: Approval | undefined,
    marks: InputMarks,
  ) {
    if (!marks.style.shown || typeof target !== "string")
      return yield* resolve(operation, target, approval);

    // Inspection and policy approval happen before this point. Every retry is geometry only;
    // scrolling never obtains a fresh approval or silently follows a replacement document.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* readPoint(operation, target, approval, false);

      if (!("error" in result)) return resolvedTarget(result);
      if (result.error !== "offscreen") return yield* pointFailure(operation, target, result);

      const plan = yield* mutate(operation, scriptCall("scrollPlan", target), approval).pipe(
        Effect.flatMap(decodeWith(operation, Script.ScrollPlanSchema)),
      );

      if (plan === null) break;
      const size = yield* viewport.viewportFor(operation);
      const point = { x: plan.x, y: plan.y };

      yield* marks.at(point);
      yield* moveTo(operation, marks, point);
      const before = settling.mark();

      yield* wheel(
        operation,
        marks,
        point,
        Math.max(-size.width * 0.9, Math.min(size.width * 0.9, plan.dx)),
        Math.max(-size.height * 0.9, Math.min(size.height * 0.9, plan.dy)),
      );
      yield* flush(operation, marks.input);
      yield* settling.settle(operation, before);
      yield* check(approval);
    }

    // Wheels may be prevented or the target may need unsupported nested/frame geometry. One
    // explicit fallback preserves reachability without a distance-dependent protocol loop.
    yield* marks.touched;
    const before = settling.mark();

    yield* resolve(operation, target, approval);
    yield* settling.settle(operation, before);
    yield* check(approval);

    return yield* resolve(operation, target, approval, false);
  });

  return { resolve, targetFor };
};

export type Targets = ReturnType<typeof make>;
