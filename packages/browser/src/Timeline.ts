import { Effect, Schema, type Stream } from "effect";

import { guardedDecode } from "./internal/browser/PlanInput.ts";
import {
  ClientEvent as ClientEventSchema,
  ClientEventJson,
  ClientPageEvent as ClientPageEventSchema,
  ClientPageEventJson,
  CursorJson,
  EventJson,
  SnapshotJson,
  TimelineMalformed,
  type ClientPageEvent,
  type ClientEvent,
  type Cursor,
  type Event,
  type PageEvent,
  type Selector,
  type Snapshot,
  type SnapshotOptions,
  type Stamp,
  type TimelineError,
} from "./TimelineData.ts";

export {
  TimelineCursorError,
  TimelineGap,
  TimelineLimit,
  TimelineMalformed,
  type TimelineError,
} from "./TimelineData.ts";

/** A live host capability; its streams replay metadata, never native mutations. */
export interface Timeline {
  readonly snapshot: (options?: SnapshotOptions) => Effect.Effect<Snapshot, TimelineError>;
  readonly events: (selector?: Selector) => Stream.Stream<Event, TimelineError>;
  readonly now: Effect.Effect<Stamp>;
}

/** Host evidence encoding retains bounded addresses and uses decimal-string bigint offsets. */
export const encode = (event: Event) =>
  Schema.encodeEffect(EventJson)(event).pipe(Effect.mapError(() => new TimelineMalformed({})));

/** Explicit client projection excludes host address fields even on augmented host values. */
export const project = (event: Event): Effect.Effect<ClientEvent, TimelineMalformed> =>
  Schema.decodeEffect(ClientEventSchema)(event).pipe(
    Effect.map((value) => Object.freeze(value)),
    Effect.mapError(() => new TimelineMalformed({})),
  );

export const encodeClient = (event: Event) =>
  project(event).pipe(
    Effect.flatMap((value) => Schema.encodeEffect(ClientEventJson)(value)),
    Effect.mapError(() => new TimelineMalformed({})),
  );

export const decode = (value: unknown): Effect.Effect<Event, TimelineMalformed> =>
  guardedDecode(EventJson)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new TimelineMalformed({})),
  );

export const encodeCursor = (cursor: Cursor) =>
  Schema.encodeEffect(CursorJson)(cursor).pipe(Effect.mapError(() => new TimelineMalformed({})));

export const decodeCursor = (value: unknown) =>
  guardedDecode(CursorJson)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new TimelineMalformed({})),
  );

export const encodeSnapshot = (snapshot: Snapshot) =>
  Schema.encodeEffect(SnapshotJson)(snapshot).pipe(
    Effect.mapError(() => new TimelineMalformed({})),
  );

/** Copy the allowlisted lifecycle projection; cached host addresses/titles remain private. */
export const projectPages = (value: PageEvent): Effect.Effect<ClientPageEvent, TimelineMalformed> =>
  Schema.decodeEffect(ClientPageEventSchema)(value).pipe(
    Effect.map((projected) => Object.freeze(projected)),
    Effect.mapError(() => new TimelineMalformed({})),
  );

export const encodePages = (value: PageEvent) =>
  projectPages(value).pipe(
    Effect.flatMap((projected) => Schema.encodeEffect(ClientPageEventJson)(projected)),
    Effect.mapError(() => new TimelineMalformed({})),
  );
