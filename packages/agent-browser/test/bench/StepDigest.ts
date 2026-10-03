import { Effect } from "effect";
import type { ToolCallSnapshot } from "effect-agent-browser/tools";
import type { StepAttempt } from "effect-browser/plan-data";
import type { CachedPage, Snapshot, Stamp } from "effect-browser/timeline-data";

export interface StepFact {
  readonly action: string;
  readonly targetLabel: string | null;
  readonly outcome: string | null;
}

export const fromAttempt = (attempt: StepAttempt): StepFact => {
  const action = attempt.sourceStep.action;
  const captured = attempt.capture?._tag === "Complete" ? attempt.capture.action : undefined;
  const target = captured !== undefined && "target" in captured ? captured.target : undefined;
  const authored = "target" in action ? action.target : undefined;

  const label =
    target?._tag === "Descriptor"
      ? target.descriptor.label
      : authored?._tag === "Descriptor"
        ? authored.descriptor.label
        : undefined;

  return {
    action: action._tag,
    targetLabel: label ?? null,
    outcome: attempt.result?.outcome ?? attempt.outcome ?? null,
  };
};

/** Resolve live host handles once; the pure projection below never performs browser work. */
export const fromReceipts = (snapshot: ToolCallSnapshot) =>
  Effect.forEach(snapshot.receipts, (receipt) =>
    Effect.gen(function* () {
      if (receipt._tag === "Run")
        return (yield* receipt.operation.attempts).attempts.map(fromAttempt);
      if (receipt._tag === "Navigation") {
        const result = yield* receipt.operation.completed.pipe(Effect.exit);

        return [
          {
            action: "Navigate",
            targetLabel: null,
            outcome: result._tag === "Success" ? "performed" : null,
          },
        ];
      }
      const error = receipt.error;

      return [
        {
          action: receipt.toolName,
          targetLabel: null,
          outcome: error._tag === "StepFailed" ? error.error.outcome : error.outcome,
        },
      ];
    }),
  ).pipe(Effect.map((groups) => groups.flat()));

/** Model-facing addresses omit credentials and fixture/private query and fragment values. */
const address = (url: string | null) => {
  if (url === null) return null;
  try {
    const parsed = new URL(url);

    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";

    return parsed.href;
  } catch {
    return null;
  }
};

/** All times share the owner's clock; unavailable or foreign-frame facts stay null. */
export const build = (input: {
  readonly steps: ReadonlyArray<StepFact>;
  readonly timeline: Snapshot;
  readonly now: Stamp;
  readonly page: CachedPage | undefined;
  readonly sinceSequence?: bigint;
  readonly droppedReceipts?: number;
}) => {
  const { timeline, page, now } = input;

  const current = timeline.events.filter(
    (event) =>
      page !== undefined &&
      event.target?.generation === page.identity.generation &&
      event.target.pageId === page.identity.pageId &&
      event.target.frameId === page.identity.frameId &&
      event.clockId === now.clockId,
  );

  const recent = current.filter(
    (event) => input.sinceSequence === undefined || event.sequence > input.sinceSequence,
  );

  const navigated = recent.findLast((event) => event.event._tag === "Navigated");

  const boundary = current.findLast(
    (event) => event.event._tag === "CaptureBoundary" || event.event._tag === "Capture",
  );

  const capture = boundary?.event;

  // Capture attribution has its own document numbers; it never identifies a native document epoch.
  const firstFrame = current.findLast(
    (event) =>
      event.event._tag === "FirstFrame" &&
      capture !== undefined &&
      (capture._tag === "CaptureBoundary" || capture._tag === "Capture") &&
      event.event.captureId === capture.captureId &&
      event.event.captureBoundary === capture.captureBoundary &&
      event.event.captureDocument === capture.captureDocument,
  );

  const frameStamp =
    firstFrame?.event._tag === "FirstFrame" ? firstFrame.event.received : undefined;

  const latestFailure = recent.findLast(
    (event) => event.event._tag === "Failed" || event.event._tag === "Cancelled",
  );

  return {
    steps: input.steps,
    navigation:
      navigated?.event._tag === "Navigated"
        ? {
            sameDocument: navigated.event.sameDocument,
            address:
              navigated.event.urlQualification === "NativeCached"
                ? address(navigated.event.url)
                : null,
            title: page?.titleQualification === "ObservedCached" ? page.title : null,
          }
        : null,
    settlement: recent.some((event) => event.event._tag === "Settled")
      ? "observed"
      : "not-observed",
    firstFrameAgeMillis:
      frameStamp !== undefined &&
      frameStamp.clockId === now.clockId &&
      now.offsetNanos >= frameStamp.offsetNanos
        ? Number(now.offsetNanos - frameStamp.offsetNanos) / 1e6
        : null,
    firstFrameQualification: frameStamp === undefined ? null : "received-boundary-attribution",
    failure:
      latestFailure?.event._tag === "Failed"
        ? {
            outcome: latestFailure.event.outcome,
            reason: latestFailure.event.reason,
          }
        : latestFailure?.event._tag === "Cancelled"
          ? {
              outcome: latestFailure.event.outcome,
              reason: "Cancelled",
            }
          : null,
    complete: (input.droppedReceipts ?? 0) === 0 && timeline.evicted === 0,
  };
};

export type StepDigest = ReturnType<typeof build>;
