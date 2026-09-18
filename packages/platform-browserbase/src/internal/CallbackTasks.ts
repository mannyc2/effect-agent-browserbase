/** Native callbacks cannot await a Semaphore. Reserve a bounded slot synchronously
 * before starting native work; never construct an already-running Promise first.
 * Overflow fails the connection closed once. Accepted rejections remain observed
 * after close, and no callback-side Fiber or unbounded producer queue is created. */
export class CallbackTasks {
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private faulted = false;

  private readonly capacity: number;
  private readonly onFault: () => void;

  constructor(capacity: number, onFault: () => void) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("Invalid callback capacity");
    this.capacity = capacity;
    this.onFault = onFault;
  }

  private fault(): void {
    if (this.stopped || this.faulted) return;
    this.faulted = true;
    this.onFault();
  }

  submit(action: () => Promise<unknown>): boolean {
    if (this.stopped || this.faulted) return false;
    if (this.pending.size >= this.capacity) {
      this.fault();

      return false;
    }

    const task = Promise.resolve()
      .then(action)
      .then(
        () => {},
        () => this.fault(),
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
