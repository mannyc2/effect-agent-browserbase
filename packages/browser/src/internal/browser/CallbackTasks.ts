export type CallbackFailureMode = "reject-call" | "fail-session";

export type CallbackDisposition = "not-dispatched" | "unknown";

/** Native callbacks cannot await a Semaphore. Reserve a bounded slot synchronously
 * before starting native work; never construct an already-running Promise first.
 * Fail-session pressure/failure fences the connection once. Reject-call pressure or
 * failure remains local to that invocation and reopens admission when accepted work
 * settles. Accepted rejections remain observed after close, and no callback-side Fiber
 * or unbounded producer queue is created. */
export class CallbackTasks {
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private faulted = false;

  private readonly capacity: number;
  private readonly onFault: (disposition: CallbackDisposition) => void;

  constructor(capacity: number, onFault: (disposition: CallbackDisposition) => void) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Invalid callback capacity");
    this.capacity = capacity;
    this.onFault = onFault;
  }

  private fault(disposition: CallbackDisposition): void {
    if (this.stopped || this.faulted) return;
    this.faulted = true;
    this.onFault(disposition);
  }

  submit(
    action: () => Promise<unknown>,
    failureMode: CallbackFailureMode = "fail-session",
  ): boolean {
    if (this.stopped || this.faulted) return false;
    if (this.pending.size >= this.capacity) {
      if (failureMode === "fail-session") this.fault("not-dispatched");

      return false;
    }

    const task = Promise.resolve()
      .then(action)
      .then(
        () => {},
        () => {
          if (failureMode === "fail-session") this.fault("unknown");
        },
      )
      .finally(() => this.pending.delete(task));

    this.pending.add(task);

    return true;
  }

  stop(): void {
    this.stopped = true;
  }

  async settle(): Promise<void> {
    await Promise.all(this.pending);
  }
}
