import { Effect } from "effect";

import type { PageStatus } from "../../Browser.ts";
import type { PageInfo, Target } from "../../BrowserData.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import type { CaptureSource } from "./Driver.ts";
import type { Owner, Ticket } from "./Owner.ts";
import type { PageControls } from "./Session.ts";

export interface CaptureLease {
  readonly pageId: string;
  readonly stop: Effect.Effect<void>;
  readonly invalidate: (reason: string) => void;
  readonly reservedBytes: number;
}

export interface CaptureResolution {
  /** Stable native page identity used to quarantine an unconfirmed screencast across reconnects. */
  readonly key: string;
  readonly target: Target;
  readonly source: CaptureSource;
  /** Retains one bounded authority record after it leaves the owner's live inventory. */
  readonly status?: () => Pick<PageStatus, "phase" | "containment">;
}

export interface CaptureParent {
  readonly validate?: Effect.Effect<void, BrowserError>;
  readonly owner: Owner;
  readonly resolve: (
    ticket: Ticket,
    target?: PageInfo,
  ) => Effect.Effect<CaptureResolution, BrowserError>;
  readonly target: () => Target;
  readonly selectedPage: () => PageInfo;
  readonly captureLeases: Map<string, CaptureLease>;
  captureReservedBytes: number;
}

// This is a private capability registry, not stored domain data. Exact live session identity is
// required: spreading/cloning a session must not copy authority to mutate its capture owner,
// leases or reservations. A public/enumerable parent field would weaken that boundary.
// Keep this access centralized here; schemas describe data, never this mutable ownership state.
const parents = new WeakMap<object, CaptureParent>();

export const associate = (session: object, parent: CaptureParent): void => {
  parents.set(session, parent);
};

export const captureParent = (session: object): CaptureParent | undefined => parents.get(session);

/** A page delegates to the same owner and accounting; its destination cannot be replaced. */
export const forPage = (
  parent: CaptureParent,
  info: PageInfo,
  identity: Target,
  validate: Effect.Effect<void, BrowserError>,
): CaptureParent => ({
  validate,
  owner: parent.owner,
  captureLeases: parent.captureLeases,
  get captureReservedBytes() {
    return parent.captureReservedBytes;
  },
  set captureReservedBytes(value) {
    parent.captureReservedBytes = value;
  },
  target: () => identity,
  selectedPage: () => info,
  resolve: (ticket, requested) =>
    validate.pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (ticket.generation !== identity.generation)
            return Effect.fail(
              BrowserError.make({
                operation: "capture",
                reason: Reasons.Stale.make({}),
                outcome: "undispatched",
              }),
            );
          if (
            requested !== undefined &&
            (requested.pageId !== info.pageId || requested.targetId !== info.targetId)
          )
            return Effect.fail(
              BrowserError.make({
                operation: "capture",
                reason: Reasons.Configuration.make({ path: "target" }),
                outcome: "undispatched",
              }),
            );

          return parent
            .resolve(ticket, info)
            .pipe(Effect.tap(() => Effect.sync(() => ticket.check())));
        }),
      ),
    ),
});

const pageAuthorities = new WeakMap<object, PageControls>();

export const associatePageAuthority = (page: object, controls: PageControls): void => {
  pageAuthorities.set(page, controls);
};

/** Provider bridges borrow the exact issued page on this session's original owner. */
export const resolvePageControlsForSession = (
  session: object,
  page: object,
): Effect.Effect<PageControls, BrowserError> =>
  Effect.suspend(() => {
    const owner = parents.get(session)?.owner;
    const controls = pageAuthorities.get(page);

    if (owner === undefined || parents.get(page)?.owner !== owner || controls === undefined)
      return Effect.fail(
        BrowserError.make({
          operation: "target",
          reason: Reasons.UnregisteredSession.make({}),
          outcome: "undispatched",
        }),
      );

    return controls.validate.pipe(Effect.as(controls));
  });
