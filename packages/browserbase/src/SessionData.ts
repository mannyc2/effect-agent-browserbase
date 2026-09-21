import { Schema } from "effect";

import { Identifier, SessionReference } from "./References.ts";

export const SessionStatus = Schema.Literals([
  "PENDING",
  "RUNNING",
  "ERROR",
  "TIMED_OUT",
  "COMPLETED",
]);

export type SessionStatus = typeof SessionStatus.Type;

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  status === "COMPLETED" || status === "ERROR" || status === "TIMED_OUT";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));

export const ProviderSession = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  keepAlive: Schema.Boolean,
  proxyBytes: Schema.Finite,
  region: Schema.Literals(["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"]),
  contextId: Schema.optionalKey(Identifier),
});

export class SessionMetadata extends Schema.Class<SessionMetadata>("BrowserbaseSessionMetadata")({
  reference: SessionReference,
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  keepAlive: Schema.Boolean,
  proxyBytes: Schema.Finite,
  region: ProviderSession.fields.region,
  contextId: Schema.optionalKey(Identifier),
}) {}
