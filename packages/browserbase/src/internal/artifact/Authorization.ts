import { Effect } from "effect";

import type { SessionError } from "../../Errors.ts";
import type { SessionReference } from "../../References.ts";
import { isTerminalSessionStatus } from "../../SessionData.ts";
import type { BrowserbaseSessions } from "../../Sessions.ts";

/**
 * Provider artifacts belong to a finished session. This reads the exact session through the
 * one canonical resource service; it never infers terminality from an artifact listing.
 */
export const requireTerminalSession = <E>(
  sessions: BrowserbaseSessions["Service"],
  reference: SessionReference,
  active: () => E,
  rejected: (error: SessionError) => E,
) =>
  sessions.retrieve(reference).pipe(
    Effect.mapError(rejected),
    Effect.flatMap((metadata) =>
      isTerminalSessionStatus(metadata.status) ? Effect.void : Effect.fail(active()),
    ),
  );
