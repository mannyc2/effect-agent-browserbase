import type { ElementHandle } from "playwright-core";

import type { ControlFacts } from "../../BrowserData.ts";
import { Reasons } from "../../Errors.ts";
import type { DriverTarget, ElementTarget } from "./Driver.ts";
import { closeWithin, failure } from "./NativeCalls.ts";
import type { AdmissionPolicy, Observation } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";

/**
 * Exact-node admission shared by every element input: clicks, fills and forms in Actions, and
 * the pointer and keyboard drivers. It depends only on the observation seam, so those drivers
 * can be built before the actions that use them.
 */
export const makeElementAccess = (observation: Observation) => {
  const targetFor = (element: ElementTarget, target: DriverTarget): DriverTarget => {
    if (typeof element === "string" || !("_tag" in element)) return target;
    if (target.pageId !== element.target.pageId)
      throw failure(Reasons.Stale.make({}), "undispatched");

    return element.target;
  };

  /**
   * Acts on the exact attached node a target names. The observation seam establishes that it is
   * still the control that was inspected and that the host's policy, if any, admits it. `admit`
   * then sees that node before anything is dispatched, so a refusal it raises is undispatched
   * too, and what it learns reaches the action without the node being resolved a second time.
   * `enablement` is a form step's: see `Observation.resolve`.
   */
  const withAdmittedElement = async <Admitted, A>(
    target: ElementTarget,
    ticket: Ticket,
    admit: (element: ElementHandle<Element>, facts: ControlFacts | undefined) => Promise<Admitted>,
    action: (
      element: ElementHandle<Element>,
      admitted: Admitted,
      check: () => void,
      readmit: () => Promise<void>,
    ) => Promise<A>,
    policy: AdmissionPolicy | undefined,
    browserTarget: DriverTarget,
    enablement = false,
    automaticDispatch = true,
  ): Promise<A> => {
    const { element, check, readmit, facts, capture, release } = await observation.resolve(
      target,
      ticket,
      policy,
      false,
      targetFor(target, browserTarget),
      enablement,
      ticket.performance !== undefined,
    );

    try {
      check();
      const admitted = await admit(element, facts);

      check();
      ticket.check();
      ticket.captureTarget?.(target, capture);
      // ElementHandle actions do not re-resolve the selector onto a replacement node.
      if (automaticDispatch) ticket.dispatch();

      const result = await action(element, admitted, check, readmit);

      ticket.acknowledge?.();
      ticket.followUp?.();

      return result;
    } finally {
      await closeWithin(release).catch(() => {});
    }
  };

  const withElement = <A>(
    target: ElementTarget,
    ticket: Ticket,
    action: (
      element: ElementHandle<Element>,
      admitted: void,
      check: () => void,
      readmit: () => Promise<void>,
    ) => Promise<A>,
    policy: AdmissionPolicy | undefined,
    browserTarget: DriverTarget,
    automaticDispatch = true,
  ): Promise<A> =>
    withAdmittedElement(
      target,
      ticket,
      async () => {},
      action,
      policy,
      browserTarget,
      false,
      automaticDispatch,
    );

  return { targetFor, withAdmittedElement, withElement };
};

export type ElementAccess = ReturnType<typeof makeElementAccess>;
