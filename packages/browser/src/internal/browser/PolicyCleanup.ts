import type { DriverEvents, DriverFault } from "./Driver.ts";

type PolicyReason = Extract<DriverFault, { readonly source: "policy" }>["reason"];

export type CleanupDisposition = "confirmed" | "not-dispatched" | "unknown";

interface CleanupOptions {
  /** Absent for an ordinary policy close or dismissal within the configured bounds. */
  readonly overflow?: PolicyReason;
  /** A modeled dismissal checks its ticket immediately before the native dispatch. */
  readonly dispatch?: () => void;
  /** Delivers one bounded result, including to the captured before-unload navigation. */
  readonly settled?: (disposition: CleanupDisposition) => void;
}

/**
 * One connection's policy closes and dismissals. The timer bounds observation, never native
 * capacity: a late native promise still owns its slot. Exact objects share their first result,
 * including an uncertain result, so neither another event nor shutdown resends that command.
 */
export class PolicyCleanup {
  private readonly pending = new Set<Promise<void>>();
  private readonly results = new WeakMap<object, Promise<CleanupDisposition>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly retirements = new Set<() => void>();
  private readonly refused = {};
  private stopped = false;
  private connectionRetired = false;

  constructor(private readonly events: Pick<DriverEvents, "fault">) {}

  run(
    subject: object,
    action: () => Promise<unknown>,
    options: CleanupOptions = {},
  ): Promise<CleanupDisposition> {
    const existing = this.results.get(subject);

    if (existing !== undefined) return existing;
    let resolve: (disposition: CleanupDisposition) => void = () => {};
    let completed = false;

    const result = new Promise<CleanupDisposition>((done) => {
      resolve = done;
    });

    this.results.set(subject, result);
    const token = {};

    const record = (
      disposition: CleanupDisposition | "pending" | "dispatched",
      identity: object = token,
    ) => {
      if (this.connectionRetired) return;
      if (options.overflow !== undefined)
        this.events.fault({
          source: "policy",
          reason: options.overflow,
          token: identity,
          disposition,
        });
      else if (disposition === "unknown" || disposition === "not-dispatched")
        this.events.fault({ source: "native", reason: "callback", disposition });
    };

    const finish = (disposition: CleanupDisposition) => {
      if (completed) return;
      completed = true;
      options.settled?.(disposition);
      resolve(disposition);
    };

    if (this.stopped || this.pending.size >= 32) {
      if (!this.stopped) record("not-dispatched", this.refused);
      finish("not-dispatched");

      return result;
    }
    let dispatched = false;
    const retire = () => finish(dispatched ? "unknown" : "not-dispatched");

    this.retirements.add(retire);

    const execution = async (): Promise<CleanupDisposition> => {
      if (this.stopped) {
        return "not-dispatched";
      }
      try {
        options.dispatch?.();
      } catch {
        return "not-dispatched";
      }
      dispatched = true;
      record("dispatched");

      const timer = setTimeout(() => {
        this.timers.delete(timer);
        record("unknown");
        finish("unknown");
      }, 2000);

      this.timers.add(timer);
      try {
        await action();

        return "confirmed";
      } catch {
        return "unknown";
      } finally {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    };

    const task = Promise.resolve()
      .then(execution)
      .then((disposition) => {
        // Release capacity before waking a confirmed waiter that may submit the next cleanup.
        this.pending.delete(task);
        this.retirements.delete(retire);
        // A late acknowledgement is evidence, but cannot change the waiter's unknown result.
        if (!completed || disposition === "confirmed") record(disposition);
        finish(disposition);
      });

    this.pending.add(task);
    record("pending");

    return result;
  }

  /** Stop admission before native disconnection; accepted promises remain observed. */
  stop(): void {
    this.stopped = true;
  }

  /** Only confirmed connection retirement may forget deadline observers of unresolved work. */
  retired(): void {
    this.stop();
    this.connectionRetired = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const retire of this.retirements) retire();
    this.retirements.clear();
    this.pending.clear();
  }

  async settle(): Promise<void> {
    await Promise.all(this.pending);
  }
}
