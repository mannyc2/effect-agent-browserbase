/** Resource generations, typed acquisition failures and the public supervision contract. */
import {
  type Cause,
  Data,
  type Duration,
  type Effect,
  Schema,
  type Schedule,
  type Scope,
  type Stream,
} from "effect";

import type { Released } from "../providers/Released.ts";

/** Why a generation stopped serving. */
export const Why = Schema.Literals(["lost", "rotated", "retired"]);
export type Why = typeof Why.Type;

/** A resource acquired in the generation's scope. The core never inspects its value. */
export interface Opened<A> {
  readonly value: A;
  /** Watched until the generation's scope closes, after its release. */
  readonly lost?: Effect.Effect<string> | undefined;
  /** Without a release hook, closing the generation's scope ends the resource. */
  readonly release?: ((why: Why) => Effect.Effect<Released>) | undefined;
}

export interface Options<A, E, R> {
  /** Each try receives its generation number and owns resources in the supplied Scope. */
  readonly open: (number: number) => Effect.Effect<Opened<A>, E, R>;
  /** Defaults to exponential from one second, for five minutes. */
  readonly reopen?: Schedule.Schedule<unknown, E> | undefined;
  readonly definite?: ((error: E) => boolean) | undefined;
  /** Each generation waits until every earlier release has completed. */
  readonly exclusive?: boolean | undefined;
}

/** Every failed try retains its own typed error, including any provider cleanup evidence. */
export type State<E> =
  | { readonly _tag: "Opening"; readonly attempt: number }
  | { readonly _tag: "Failed"; readonly attempt: number; readonly error: E }
  | { readonly _tag: "Down"; readonly error: E | undefined; readonly detail: string }
  | { readonly _tag: "Open" }
  | { readonly _tag: "Ending"; readonly why: Why; readonly detail?: string | undefined }
  | { readonly _tag: "Closed"; readonly released?: Released | undefined };

export interface Generation<E = unknown> {
  readonly number: number;
  /** Epoch milliseconds on the owning Effect clock. */
  readonly at: number;
  /** Monotonic milliseconds on the same clock. */
  readonly hostTime: number;
  readonly state: State<E>;
}

/** No generation serves because opening failed permanently or the supervisor retired. */
export class Unavailable<E = unknown> extends Data.TaggedError("Unavailable")<{
  readonly reason: "down" | "retired";
  readonly error?: E | undefined;
  readonly detail: string;
}> {
  override get message() {
    return `no resource: ${this.detail}`;
  }
}

/** Revoked work still uses its input receipt to determine whether input reached the site. */
export class Superseded extends Schema.TaggedError<Superseded>()("Superseded", {
  generation: Schema.Int,
  reason: Why,
}) {}

export interface Lease<A> {
  readonly generation: number;
  readonly value: A;
  readonly ending: Effect.Effect<Why>;
  /** Stale declarations do nothing. */
  readonly lose: (detail: string) => Effect.Effect<void>;
}

/** A public admission budget must be finite and nonnegative. */
export class InvalidWait extends Data.TaggedError("InvalidWait")<{ readonly detail: string }> {}

export interface UseOptions {
  /** Finite nonnegative admission budget on the owner's clock. Zero peeks; absent waits. */
  readonly wait?: Duration.Input | undefined;
}

export interface Supervisor<A, E = unknown> {
  /** Ending interrupts the work and awaits its scoped cleanup before releasing the resource. */
  readonly use: <B, E2, R>(
    work: (lease: Lease<A>) => Effect.Effect<B, E2, R>,
    options?: UseOptions,
  ) => Effect.Effect<
    B,
    E2 | Unavailable<E> | Superseded | Cause.TimeoutError | InvalidWait,
    Exclude<R, Scope.Scope>
  >;
  /** Replays the latest 64 changes; ends only after every try and release has finished. */
  readonly states: Stream.Stream<Generation<E>>;
  /** Replace the current generation. A stale `from` does nothing. */
  readonly rotate: (from?: number) => Effect.Effect<void, Unavailable<E>>;
  /** The stop runs on its own fiber; abandoning this wait never abandons retirement. */
  readonly retire: Effect.Effect<void>;
}
