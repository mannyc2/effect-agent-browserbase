import {
  CaptureTimingTrace,
  observeCaptureFrames,
  type CaptureDiscontinuity,
} from "./CaptureTiming.ts";

export type CaptureEnd =
  | "stop-confirmed"
  | "stop-failed"
  | "start-failed"
  | "page-closed"
  | "disconnected"
  | "superseded";

export interface CaptureLifecycleEvidence {
  readonly end: CaptureEnd;
  readonly startedMonotonicNanos: string | null;
  readonly acknowledgedMonotonicNanos: string | null;
  readonly completedMonotonicNanos: string | null;
  readonly received: number;
  readonly firstReceived: ReturnType<CaptureTimingTrace["snapshot"]>["firstReceived"];
  readonly lastReceived: ReturnType<CaptureTimingTrace["snapshot"]>["lastReceived"];
}

/** Test-only metadata observer. No timers, native retries, retained images or altered callback outcomes. */
export const captureLifecycle = <
  A extends {
    readonly timestamp: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
  },
  B,
>(
  callback: (frame: A) => B,
  reportBackward: (event: CaptureDiscontinuity) => void,
  reportEnd: (event: CaptureLifecycleEvidence) => void,
  now: () => bigint,
) => {
  const sample = () => {
    try {
      return now().toString();
    } catch {
      return null;
    }
  };

  const trace = new CaptureTimingTrace();
  const startedMonotonicNanos = sample();
  let acknowledgedMonotonicNanos: string | null = null;
  let completed = false;

  return {
    receive: observeCaptureFrames(callback, reportBackward, now, trace),
    acknowledged: () => {
      if (!completed) acknowledgedMonotonicNanos = sample();
    },
    finish: (end: CaptureEnd) => {
      if (completed) return;
      completed = true;
      const snapshot = trace.snapshot();

      try {
        reportEnd({
          end,
          startedMonotonicNanos,
          acknowledgedMonotonicNanos,
          completedMonotonicNanos: sample(),
          received: snapshot.received,
          firstReceived: snapshot.firstReceived,
          lastReceived: snapshot.lastReceived,
        });
      } catch {
        // Failure of diagnostics must not replace a native stop/start result.
      }
    },
  };
};
