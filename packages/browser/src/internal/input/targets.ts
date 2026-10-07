/**
 * Where an action's input goes: a ref or a point resolved to a control and a viewport point,
 * scrolled into view first when it is outside the viewport.
 */
import { Effect } from "effect";

import { InvalidRequest, NotActionable, StaleRef } from "../../BrowserError.ts";
import { ResolvedTarget, type Target } from "../../Page.ts";
import { type Bridge, scriptCall } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import type { Dispatch } from "./dispatch.ts";
import type { Approval, Guard } from "./guard.ts";
import type { InputMarks } from "./perform.ts";
import type { Pointer } from "./pointer.ts";
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

const resolvedTarget = (result: Script.ResolvedPoint): ResolvedTarget =>
  new ResolvedTarget({
    point: { x: result.x, y: result.y },
    element: result.element,
    tag: result.tag,
    role: result.role,
    name: result.name,
    context: result.context,
    cursor: result.cursor,
    ...(result.href === undefined ? {} : { href: result.href }),
  });

export const make = (
  page: PageContext,
  bridge: Bridge,
  viewport: Viewport,
  guard: Guard,
  pointer: Pointer,
  dispatch: Dispatch,
) => {
  const { settings } = page;
  const { evaluate } = bridge;
  const { mutate } = guard;
  const { moveTo, wheel } = pointer;
  const { flush } = dispatch;

  const readPoint = (
    operation: string,
    target: Target,
    approval: Approval | undefined,
    scroll: boolean,
  ) =>
    (approval === undefined
      ? evaluate(operation, scriptCall("point", target, scroll))
      : mutate(operation, scriptCall("point", target, scroll), approval)
    ).pipe(Effect.flatMap(decodeWith(operation, Script.PointResultSchema)));

  const resolve = (operation: string, target: Target, approval?: Approval, scroll = true) => {
    if (typeof target === "string" && !/^e\d+$/.test(target))
      return failWith(
        operation,
        new InvalidRequest({ detail: target + " is not a ref; refs look like e12" }),
      );
    if (typeof target !== "string" && (!Number.isFinite(target.x) || !Number.isFinite(target.y)))
      return failWith(
        operation,
        new InvalidRequest({ detail: "point coordinates must be finite" }),
      );

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
    if (!settings.humanize || typeof target !== "string")
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
      yield* wheel(
        operation,
        marks.input,
        point,
        Math.max(-size.width * 0.9, Math.min(size.width * 0.9, plan.dx)),
        Math.max(-size.height * 0.9, Math.min(size.height * 0.9, plan.dy)),
      );
      yield* flush(operation, marks.input);
      yield* Effect.sleep("150 millis");
      if (approval !== undefined) yield* approval.check();
    }

    // Wheels may be prevented or the target may need unsupported nested/frame geometry. One
    // explicit fallback preserves reachability without a distance-dependent protocol loop.
    yield* marks.touched;
    yield* resolve(operation, target, approval);
    yield* Effect.sleep("150 millis");
    if (approval !== undefined) yield* approval.check();

    return yield* resolve(operation, target, approval, false);
  });

  return { resolve, targetFor };
};

export type Targets = ReturnType<typeof make>;
