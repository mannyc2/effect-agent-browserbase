import { Result, Schema } from "effect";
import type { ElementHandle, Page } from "playwright-core";

import type { InputReceipt } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { makeActions } from "./Actions.ts";
import type { DriverTarget, ElementTarget } from "./Driver.ts";
import { failure, safeDecode, sanitize } from "./NativeCalls.ts";
import { ownerPacing } from "./NativePacing.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import { move as moveSchedule, pointer as pointerSchedule } from "./Performance.ts";
import type { Targets } from "./Targets.ts";

export interface NativePoint {
  readonly x: number;
  readonly y: number;
}

/** What one native pointer command did. The session adds target identity and the host clock. */
export interface NativeInput {
  /** The last point this driver commanded on the page, or null if it never placed the pointer. */
  readonly position: NativePoint | null;
  readonly intended?: InputReceipt["intended"];
}

const Reach = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  reachable: Schema.Boolean,
});

/** Runs in each document on the path to the exact node, including cross-origin frames. */
const hitPoint = (
  node: Node,
  input: NativePoint & { readonly child: boolean },
): { readonly x: number; readonly y: number; readonly reachable: boolean } => {
  const refused = { x: input.x, y: input.y, reachable: false };

  if (
    !(node instanceof Element) ||
    !node.isConnected ||
    input.x < 0 ||
    input.y < 0 ||
    input.x >= innerWidth ||
    input.y >= innerHeight
  )
    return refused;

  let hit = node.ownerDocument.elementFromPoint(input.x, input.y);

  for (let depth = 0; hit?.shadowRoot; depth++) {
    if (depth >= 32) return refused;
    const inner = hit.shadowRoot.elementFromPoint(input.x, input.y);

    if (inner === null || inner === hit) break;
    hit = inner;
  }
  if (hit === null || (hit !== node && !node.contains(hit))) return refused;
  if (!input.child) return { x: input.x, y: input.y, reachable: true };
  if (!(node instanceof HTMLElement)) return refused;

  // Mapping a bounding rectangle through rotation/perspective would guess a point. Admit
  // positive axis-aligned scaling/translation; reject unsupported transforms before input.
  let ancestor: Element | null = node;

  for (let depth = 0; ancestor !== null; depth++) {
    if (depth >= 128) return refused;
    const style = getComputedStyle(ancestor);
    const rotation = style.getPropertyValue("rotate");
    const scale = style.getPropertyValue("scale");

    if (
      (rotation !== "" && rotation !== "none" && rotation !== "0deg") ||
      (scale !== "" &&
        scale !== "none" &&
        scale.split(/\s+/).some((axis) => !(Number.parseFloat(axis) > 0))) ||
      style.perspective !== "none" ||
      (style.offsetPath !== "" && style.offsetPath !== "none")
    )
      return refused;
    if (style.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(style.transform);

      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0)
        return refused;
    }
    const root = ancestor.getRootNode();

    ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }

  const rect = node.getBoundingClientRect();
  const scaleX = rect.width / node.offsetWidth;
  const scaleY = rect.height / node.offsetHeight;

  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
    return refused;
  const style = getComputedStyle(node);
  const left = Number.parseFloat(style.paddingLeft);
  const top = Number.parseFloat(style.paddingTop);
  const right = Number.parseFloat(style.paddingRight);
  const bottom = Number.parseFloat(style.paddingBottom);
  const x = (input.x - rect.left) / scaleX - node.clientLeft - left;
  const y = (input.y - rect.top) / scaleY - node.clientTop - top;

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x >= node.clientWidth - left - right ||
    y >= node.clientHeight - top - bottom
  )
    return refused;

  return { x, y, reachable: true };
};

/**
 * Real pointer input to the exact target page. Every command is one the browser would receive from
 * a person, so handlers see trusted events and the browser decides what is under the pointer.
 * Nothing here scrolls, eases or retries: a caller that wants a trajectory sends its points.
 */
export const makePointer = (targets: Targets, actions: ReturnType<typeof makeActions>) => {
  const { current } = targets;
  // Chromium keeps a pointer position per page; this is only the last one this driver set.
  const positions = new WeakMap<Page, NativePoint | null>();
  // Where the last input on a page aimed. A click leaves the actual position unknown, but the
  // next performed glide still starts from its aim; this is never reported as a position.
  const aims = new WeakMap<Page, NativePoint>();

  const moveTo = async (page: Page, point: NativePoint): Promise<void> => {
    await page.mouse.move(point.x, point.y);
    positions.set(page, point);
    aims.set(page, point);
  };

  const receipt = (page: Page): NativeInput => ({ position: positions.get(page) ?? null });

  const invalidate = (page: Page, aim?: NativePoint): void => {
    positions.set(page, null);
    if (aim === undefined) aims.delete(page);
    else aims.set(page, aim);
  };

  const glideFrom = (page: Page) => positions.get(page) ?? aims.get(page) ?? null;

  const pointerMove = (point: NativePoint, ticket: Ticket, target: DriverTarget) =>
    sanitize(async () => {
      const { entry, frame } = current(target);
      const { page } = entry;
      const epoch = targets.epochOf(frame);

      if (ticket.performance !== undefined) {
        const pacing = ownerPacing(ticket);

        const viewport = safeDecode(
          Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
          await page.mainFrame().evaluate(() => ({ width: innerWidth, height: innerHeight })),
        );

        ticket.check();

        const planned = moveSchedule(ticket.performance.plan, {
          from: glideFrom(page),
          to: point,
          viewport,
        });

        if (Result.isFailure(planned)) throw planned.failure;
        pacing.requireDuration(planned.success.durationMillis);
        const started = pacing.now();

        if (planned.success.samples.length >= 2)
          ticket.recordGlide?.({
            target: { pageId: entry.id, frameId: targets.frameId(frame) },
            startedMonotonicNanos: started,
            samples: planned.success.samples,
          });
        if (planned.success.durationMillis > 0)
          await pacing.pauseUntil(
            started + BigInt(Math.round(planned.success.durationMillis * 1e6)),
          );
        ticket.check();
        if (current(target).frame !== frame || targets.epochOf(frame) !== epoch)
          throw failure(Reasons.Stale.make({}), "undispatched");
      }
      ticket.dispatch();
      await moveTo(page, point);
      ticket.acknowledge?.();
      ticket.followUp?.();
      ticket.check();

      return receipt(page);
    });

  /**
   * The centre of the element's box, in main-frame viewport pixels, and only if the pointer can
   * really be placed there: the box has area, the point is inside the viewport, and the element
   * is what the browser finds at that point. An open shadow root is followed to the node a
   * person would actually be over.
   */
  const reachablePoint = async (
    page: Page,
    element: ElementHandle<Element>,
    requested?: NativePoint,
    check: () => void = () => {},
  ): Promise<NativePoint> => {
    check();
    const box = await element.boundingBox();

    check();

    if (box === null || box.width <= 0 || box.height <= 0)
      throw failure(Reasons.NotVisible.make({}), "undispatched");
    const point = requested ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const ancestors: Array<ElementHandle<Node>> = [];

    try {
      check();
      let frame = await element.ownerFrame();

      check();
      if (frame === null || frame.page() !== page)
        throw failure(Reasons.Stale.make({}), "undispatched");
      while (frame !== page.mainFrame()) {
        if (ancestors.length >= 32)
          throw failure(
            Reasons.Limit.make({
              dimension: "frame-depth",
              maximum: 32,
              observed: ancestors.length,
            }),
            "undispatched",
          );
        check();
        ancestors.push(await frame.frameElement());
        check();
        frame = frame.parentFrame();
        if (frame === null) throw failure(Reasons.Stale.make({}), "undispatched");
      }

      let localPoint = point;

      // A visible node in a child can still sit behind an overlay in any ancestor. Check the
      // actual commanded point from the main viewport down, then hit-test the exact node.
      for (const ancestor of ancestors.reverse()) {
        check();

        const reached = safeDecode(
          Reach,
          await ancestor.evaluate(hitPoint, { ...localPoint, child: true }),
        );

        check();
        if (!reached.reachable) throw failure(Reasons.NotVisible.make({}), "undispatched");
        localPoint = { x: reached.x, y: reached.y };
      }

      check();

      const reached = safeDecode(
        Reach,
        await element.evaluate(hitPoint, { ...localPoint, child: false }),
      );

      check();
      if (!reached.reachable) throw failure(Reasons.NotVisible.make({}), "undispatched");
    } finally {
      await Promise.all(ancestors.map((ancestor) => ancestor.dispose()));
    }

    return point;
  };

  /**
   * Plans and paces the glide to one exact node. A press may first scroll its node into view; a
   * hover never scrolls (`scrollIntoView: false`): it aims inside the node's visible part and
   * refuses a node with none `NotVisible`.
   */
  const preparePress = async (
    page: Page,
    element: ElementHandle<Element>,
    ticket: Ticket,
    check: () => void,
    options: { readonly scrollIntoView?: boolean } = {},
  ): Promise<NativeInput & { readonly intended: NonNullable<InputReceipt["intended"]> }> => {
    const pacing = ownerPacing(ticket);
    const performance = ticket.performance;

    if (performance === undefined) throw failure(Reasons.Unsupported.make({}), "undispatched");
    check();
    const frame = await element.ownerFrame();

    check();
    const pageId = targets.pageIdOf(page);

    if (frame === null || frame.page() !== page || pageId === undefined)
      throw failure(Reasons.Stale.make({}), "undispatched");
    const target = { pageId, frameId: targets.frameId(frame) };

    // In the node's own frame: whether its viewport or an overflow ancestor clips it, and the part
    // of it that stays visible, both in that frame's viewport coordinates.
    const layout = safeDecode(
      Schema.NullOr(
        Schema.Struct({
          clipped: Schema.Boolean,
          left: Schema.Finite,
          top: Schema.Finite,
          visible: Schema.Struct({
            left: Schema.Finite,
            top: Schema.Finite,
            right: Schema.Finite,
            bottom: Schema.Finite,
          }),
        }),
      ),
      await element.evaluate((node) => {
        if (!node.isConnected) return null;
        const rect = node.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) return null;

        let clipped =
          rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight;

        let left = Math.max(rect.left, 0);
        let top = Math.max(rect.top, 0);
        let right = Math.min(rect.right, innerWidth);
        let bottom = Math.min(rect.bottom, innerHeight);
        let ancestor: Element | null = node.parentElement;

        for (let depth = 0; ancestor !== null; depth++) {
          if (depth >= 128) return null;
          const style = getComputedStyle(ancestor);
          const clip = ancestor.getBoundingClientRect();

          if (style.overflowX !== "visible") {
            if (rect.left < clip.left || rect.right > clip.right) clipped = true;
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (style.overflowY !== "visible") {
            if (rect.top < clip.top || rect.bottom > clip.bottom) clipped = true;
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
          const root = ancestor.getRootNode();

          ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }

        return { clipped, left: rect.left, top: rect.top, visible: { left, top, right, bottom } };
      }),
    );

    check();
    if (layout === null) throw failure(Reasons.NotVisible.make({}), "undispatched");

    const viewport = safeDecode(
      Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
      await page.mainFrame().evaluate(() => ({ width: innerWidth, height: innerHeight })),
    );

    check();
    let box = await element.boundingBox();

    check();
    if (box === null) throw failure(Reasons.NotVisible.make({}), "undispatched");

    const outside =
      layout.clipped ||
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > viewport.width ||
      box.y + box.height > viewport.height;

    // The glide aims inside this region of the page: the whole node unless only part is visible.
    let aimRegion = box;

    if (outside && options.scrollIntoView === false) {
      // A hover never scrolls: it aims inside the part of the node that is visible now, as a plain
      // hover may, and refuses only a node with no visible part. The frame-local region moves into
      // page coordinates by the node's own offset; the hit test then checks the planned point.
      const width = layout.visible.right - layout.visible.left;
      const height = layout.visible.bottom - layout.visible.top;

      if (width <= 0 || height <= 0) throw failure(Reasons.NotVisible.make({}), "undispatched");
      aimRegion = {
        x: box.x - layout.left + layout.visible.left,
        y: box.y - layout.top + layout.visible.top,
        width,
        height,
      };
    } else if (outside) {
      const startedMonotonicNanos = pacing.now();

      ticket.dispatch();
      await element.scrollIntoViewIfNeeded({ timeout: ticket.remainingMillis() });
      ticket.acknowledge?.({ subphase: "scroll-into-view", logicalComplete: false });
      ticket.recordScroll?.({
        target,
        qualification: "exact-node-scroll-into-view",
        startedMonotonicNanos,
        completedMonotonicNanos: pacing.now(),
      });
      check();
      const scrolled = await element.boundingBox();

      check();
      if (scrolled === null) throw failure(Reasons.NotVisible.make({}), "undispatched");
      box = scrolled;
      aimRegion = scrolled;
    }

    const planned = pointerSchedule(performance.plan, {
      from: glideFrom(page),
      box: aimRegion,
      viewport,
    });

    if (Result.isFailure(planned)) throw planned.failure;
    const schedule = planned.success;

    pacing.requireDuration(schedule.durationMillis);

    await reachablePoint(page, element, schedule.aim, check);
    check();

    const border = safeDecode(
      Schema.Struct({ left: Schema.Finite, top: Schema.Finite }),
      await element.evaluate((node) => {
        const style = getComputedStyle(node);

        return {
          left: Number.parseFloat(style.borderLeftWidth),
          top: Number.parseFloat(style.borderTopWidth),
        };
      }),
    );

    check();

    const relativePosition = {
      x: schedule.aim.x - box.x - border.left,
      y: schedule.aim.y - box.y - border.top,
    };

    if (relativePosition.x < 0 || relativePosition.y < 0)
      throw failure(Reasons.NotVisible.make({}), "undispatched");
    const started = pacing.now();

    if (schedule.samples.length >= 2)
      ticket.recordGlide?.({ target, startedMonotonicNanos: started, samples: schedule.samples });
    if (schedule.durationMillis > 0)
      await pacing.pauseUntil(started + BigInt(Math.round(schedule.durationMillis * 1e6)));
    check();
    const beforeInput = await element.boundingBox();

    check();
    if (
      beforeInput === null ||
      Math.abs(beforeInput.x - box.x) > 0.01 ||
      Math.abs(beforeInput.y - box.y) > 0.01 ||
      Math.abs(beforeInput.width - box.width) > 0.01 ||
      Math.abs(beforeInput.height - box.height) > 0.01
    )
      throw failure(Reasons.Stale.make({}), "undispatched");
    await reachablePoint(page, element, schedule.aim, check);
    check();

    return {
      position: null,
      intended: {
        position: schedule.aim,
        relativePosition,
        qualification: "checked-exact-node-sample",
      },
    };
  };

  const hover = (
    target: ElementTarget,
    ticket: Ticket,
    policy: AdmissionPolicy | undefined,
    browserTarget: DriverTarget,
  ) =>
    sanitize(async () => {
      browserTarget = actions.targetFor(target, browserTarget);
      const { page } = current(browserTarget).entry;

      await actions.withAdmittedElement(
        target,
        ticket,
        (element) =>
          ticket.performance === undefined
            ? reachablePoint(page, element)
            : Promise.resolve(undefined),
        async (element, point, check, readmit) => {
          if (ticket.performance === undefined && point !== undefined) await moveTo(page, point);
          else {
            const planned = await preparePress(page, element, ticket, check, {
              scrollIntoView: false,
            });

            await readmit();
            check();
            ticket.dispatch();
            await moveTo(page, planned.intended.position);
          }
        },
        policy,
        browserTarget,
        false,
        ticket.performance === undefined,
      );
      ticket.check();

      return receipt(page);
    });

  const wheel = (
    deltaX: number,
    deltaY: number,
    at: NativePoint | undefined,
    ticket: Ticket,
    target: DriverTarget,
  ) =>
    sanitize(async () => {
      const { page } = current(target).entry;

      if (at !== undefined) {
        ticket.dispatch();
        await moveTo(page, at);
        ticket.acknowledge?.();
      }
      ticket.dispatch();
      // Dispatched, not awaited: Chromium scrolls afterwards, on its own schedule.
      await page.mouse.wheel(deltaX, deltaY);
      ticket.acknowledge?.();
      ticket.followUp?.();
      ticket.check();

      return receipt(page);
    });

  return { pointerMove, hover, wheel, receipt, invalidate, preparePress };
};
