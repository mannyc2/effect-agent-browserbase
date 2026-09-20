/** Test-only metadata. No frame bytes, URLs, selectors, credentials or vendor errors. */
export interface CaptureTimingPoint {
  readonly sequence: number;
  readonly sourceTimeMillis: number;
  readonly receivedMonotonicNanos: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface CaptureDiscontinuity {
  readonly previous: CaptureTimingPoint;
  readonly current: CaptureTimingPoint;
  readonly history: ReadonlyArray<CaptureTimingPoint>;
}

/** Observe callback order, never sort, clamp, relabel, reject or replay a frame. */
export class CaptureTimingTrace {
  static readonly capacity = 32;
  private readonly history: CaptureTimingPoint[] = [];
  private firstReceived: CaptureTimingPoint | undefined;
  private previous: CaptureTimingPoint | undefined;
  private first: CaptureDiscontinuity | undefined;
  private sequence = 0;

  record(
    frame: {
      readonly timestamp: number;
      readonly viewportWidth: number;
      readonly viewportHeight: number;
    },
    receivedMonotonicNanos: bigint,
  ): CaptureDiscontinuity | undefined {
    const current: CaptureTimingPoint = {
      sequence: this.sequence++,
      sourceTimeMillis: frame.timestamp,
      receivedMonotonicNanos: receivedMonotonicNanos.toString(),
      viewportWidth: frame.viewportWidth,
      viewportHeight: frame.viewportHeight,
    };

    this.firstReceived ??= current;
    this.history.push(current);
    if (this.history.length > CaptureTimingTrace.capacity) this.history.shift();
    const previous = this.previous;

    this.previous = current;
    if (
      this.first !== undefined ||
      previous === undefined ||
      !(current.sourceTimeMillis < previous.sourceTimeMillis)
    ) {
      return undefined;
    }
    this.first = { previous, current, history: this.history.slice() };

    return this.first;
  }

  snapshot() {
    return {
      received: this.sequence,
      recent: this.history.slice(),
      first: this.first,
      firstReceived: this.firstReceived ?? null,
      lastReceived: this.previous ?? null,
    };
  }
}

/** Diagnostic failure must not replace the original callback's value, failure or timing policy. */
export const observeCaptureFrames = <
  A extends {
    readonly timestamp: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
  },
  B,
>(
  callback: (frame: A) => B,
  report: (event: CaptureDiscontinuity) => void,
  now: () => bigint,
  trace = new CaptureTimingTrace(),
) => {
  return (frame: A): B => {
    try {
      const event = trace.record(frame, now());

      if (event !== undefined) report(event);
    } catch {
      // Only the diagnostic observer is best effort. The native callback below is not caught.
    }

    return callback(frame);
  };
};
