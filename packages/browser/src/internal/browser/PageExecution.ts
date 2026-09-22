import { PageExecutionState, PageSuspension } from "../../BrowserData.ts";
import { Reasons, BrowserError } from "../../Errors.ts";
import type { Ticket } from "./Owner.ts";

export interface PageExecutionNative {
  readonly readRate: () => Promise<number>;
  readonly rate: (value: number) => Promise<void>;
  readonly focus: (enabled: boolean) => Promise<void>;
  readonly lifecycle: (state: "active" | "frozen") => Promise<void>;
  readonly activate: () => Promise<void>;
  readonly frameBarrier: (ticket: Ticket) => Promise<void>;
  readonly closed: () => boolean;
  readonly detach: () => Promise<void>;
}

const fail = (
  reason: BrowserError["reason"],
  outcome: "undispatched" | "unknown" = "undispatched",
) => BrowserError.make({ operation: "page-control", reason, outcome });

/** Owned by one native page/connection. Cleanup never resumes or rolls back a hold. */
export class PageExecution {
  private phase: PageExecutionState["state"] = "running";
  private revision = 0;
  private receipt: PageSuspension | undefined;
  private priorRate: number | undefined;
  private disposed = false;
  readonly pageId: string;
  readonly targetId: string;
  private readonly port: PageExecutionNative;
  private readonly freshId: () => string;
  constructor(
    pageId: string,
    targetId: string,
    port: PageExecutionNative,
    freshId: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.pageId = pageId;
    this.targetId = targetId;
    this.port = port;
    this.freshId = freshId;
  }
  state(): PageExecutionState {
    if (this.disposed || this.port.closed()) throw fail(Reasons.Closed.make({}));

    return PageExecutionState.make({
      pageId: this.pageId,
      targetId: this.targetId,
      state: this.phase,
      ...(this.receipt === undefined ? {} : { suspensionId: this.receipt.suspensionId }),
    });
  }
  assertRunning(): void {
    if (this.disposed || this.port.closed()) throw fail(Reasons.Closed.make({}));
    if (this.phase !== "running") throw fail(Reasons.Busy.make({}));
  }
  invalidate(): boolean {
    const held = this.phase !== "running";

    this.revision++;
    this.receipt = undefined;
    if (held) this.phase = "unknown";

    return held;
  }
  private check(ticket: Ticket, revision: number): void {
    ticket.check();
    const outcome = ticket.dispatched ? "unknown" : "undispatched";

    if (this.disposed || this.port.closed()) throw fail(Reasons.Closed.make({}), outcome);
    if (this.revision !== revision) throw fail(Reasons.Stale.make({}), outcome);
  }
  private async write(
    ticket: Ticket,
    revision: number,
    command: () => Promise<void>,
  ): Promise<void> {
    this.check(ticket, revision);
    ticket.dispatch();
    await command();
    this.check(ticket, revision);
  }
  async suspend(ticket: Ticket): Promise<PageSuspension> {
    this.assertRunning();
    const revision = this.revision;

    this.check(ticket, revision);
    const rate = await this.port.readRate();

    this.check(ticket, revision);
    if (!Number.isFinite(rate)) throw fail(Reasons.Malformed.make({}));
    this.phase = "unknown";
    this.priorRate = rate;
    await this.write(ticket, revision, () => this.port.rate(0));
    await this.write(ticket, revision, () => this.port.focus(false));
    await this.write(ticket, revision, () => this.port.lifecycle("frozen"));

    const receipt = Object.freeze(
      PageSuspension.make({
        pageId: this.pageId,
        targetId: this.targetId,
        suspensionId: this.freshId(),
      }),
    );

    this.check(ticket, revision);
    this.receipt = receipt;
    this.phase = "suspended";

    return receipt;
  }
  async resume(receipt: PageSuspension, ticket: Ticket): Promise<void> {
    this.check(ticket, this.revision);
    if (
      this.phase !== "suspended" ||
      this.receipt === undefined ||
      receipt.pageId !== this.pageId ||
      receipt.targetId !== this.targetId ||
      receipt.suspensionId !== this.receipt.suspensionId ||
      this.priorRate === undefined
    )
      throw fail(Reasons.Stale.make({}));
    const revision = this.revision;
    const rate = this.priorRate;

    this.receipt = undefined;
    this.phase = "unknown";
    await this.write(ticket, revision, () => this.port.lifecycle("active"));
    await this.write(ticket, revision, () => this.port.activate());
    await this.write(ticket, revision, () => this.port.focus(true));
    // Blink anchors SetPlaybackRate to the last animation-frame clock. Settle one real frame at zero.
    await this.write(ticket, revision, () => this.port.frameBarrier(ticket));
    await this.write(ticket, revision, () => this.port.rate(rate));
    this.priorRate = undefined;
    this.phase = "running";
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.phase = "unknown";
    this.receipt = undefined;
    this.revision++;
    await this.port.detach();
  }
}
