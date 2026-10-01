import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { RunPhase, Step } from "../../PlanData.ts";
import type { ResolvedElement, ResolvedGroup } from "./Descriptor.ts";
import type { Driver, DriverTarget } from "./Driver.ts";
import type { Ticket } from "./Owner.ts";
import type { StepExecution } from "./PlanExecution.ts";
import { actionTargets } from "./Recording.ts";

/**
 * A plan step's native preparation. Inside the step's first admitted operation, before that
 * operation's own command, the Promise driver checks the step's preconditions and resolves its
 * targets once; every later admitted operation of the step only reactivates the resolved group.
 */
export const makeStepPreparation = (options: {
  readonly step: Step;
  readonly target: DriverTarget;
  readonly context: StepExecution;
  /** Charges preconditions and resolution to the admitted operation they run inside. */
  readonly chargeHostRead: (ticket: Ticket, operation: BrowserOperation) => void;
  /** The step's phase and field, reported again once preparation has run. */
  readonly current: () => readonly [RunPhase, number | undefined];
}) => {
  const { step, target, context, chargeHostRead } = options;
  const requests = actionTargets(step.action);
  let group: ResolvedGroup | undefined;
  let prepared = false;

  /** The element resolved for the step's `index`th target. */
  const element = (index: number): ResolvedElement => {
    const value = group?.elements[index];

    if (value === undefined)
      throw BrowserError.make({
        operation: "run",
        reason: Reasons.Incomplete.make({}),
        outcome: "undispatched",
      });

    return value;
  };

  const beforeNative = async (driver: Driver, ticket: Ticket) => {
    if (!prepared) {
      if (step.expect?.before !== undefined) {
        context.phase("Precondition");
        chargeHostRead(ticket, "run");
        await driver.expectations(step.expect.before, ticket, target);
      }
      if (requests.length > 0) {
        context.phase("Resolution");
        chargeHostRead(ticket, "resolve");
        group = await driver.resolveGroup(requests, ticket, target, step.resolution);
        context.targets(
          requests.map((request, index) => ({
            value: element(index),
            path: request.path,
            ...(group?.samples?.[index] === undefined ? {} : { sample: group.samples[index] }),
          })),
        );
      }
      prepared = true;
    }
    group?.activate(ticket);
    ticket.check();
    context.phase(...options.current());
  };

  /** Releases the resolved group's retained nodes once the step is over. */
  const release = () => group?.release() ?? Promise.resolve();

  return { requests, element, beforeNative, release };
};
