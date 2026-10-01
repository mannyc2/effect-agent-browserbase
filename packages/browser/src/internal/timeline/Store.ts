import {
  type Array as Arr,
  Cause,
  type Clock,
  Deferred,
  Effect,
  Predicate,
  type Pull,
  Result,
  Schema,
  type Scope,
} from "effect";

import {
  type Cursor,
  Event,
  EventJson,
  Selector,
  SnapshotOptions,
  TimelineCursorError,
  TimelineGap,
  TimelineLimit,
  TimelineMalformed,
  type Retention,
  type Snapshot,
  type Stamp,
  type StoreIdentity,
  type Terminal,
  type TerminalReason,
  type TimelineError,
} from "../../TimelineData.ts";

export interface View {
  readonly pageId: string;
  readonly generation: number;
  readonly terminal: () => Terminal | null;
}

export interface SubscriptionOptions {
  readonly from?: Selector;
  readonly view?: View;
}

export interface Subscription {
  readonly cursor: Cursor;
  readonly pull: Pull.Pull<Arr.NonEmptyReadonlyArray<Event>, TimelineError>;
  readonly release: () => void;
}

export type AppendInput = Pick<Event, "target" | "correlation" | "event">;

export type AppendResult =
  | { readonly _tag: "Appended"; readonly event: Event }
  | {
      readonly _tag: "Refused";
      readonly reason: "Closed" | "Malformed" | "Oversized";
      readonly bytes?: number;
    };

interface Entry {
  readonly event: Event;
  readonly bytes: number;
}

interface Reader {
  sequence: bigint;
  readonly minimumAt: bigint | undefined;
  readonly view: View | undefined;
  wake: Deferred.Deferred<void> | undefined;
  released: boolean;
}

const maximumInteger = (1n << 128n) - 1n;
const utf8 = new TextEncoder();
const decodeEvent = Schema.decodeUnknownResult(Event);
const encodeEvent = Schema.encodeResult(EventJson);
const decodeSelector = Schema.decodeUnknownResult(Selector);
const decodeSnapshotOptions = Schema.decodeUnknownResult(SnapshotOptions);
const closed = { onExcessProperty: "error" } as const;

/** Producer cost admission rejects accessors and oversized trees before semantic decoding. */
const metadataAdmission = (
  value: unknown,
  maximumBytes: number,
): "Malformed" | "Oversized" | undefined => {
  let bytes = 0;
  let nodes = 0;
  let refusal: "Malformed" | "Oversized" | undefined;
  const ancestors = new Set<object>();

  const add = (count: number) => {
    bytes += count;
    if (bytes > maximumBytes) refusal = "Oversized";
  };

  const text = (value: string) => {
    if (value.length > maximumBytes) refusal = "Oversized";
    else add(utf8.encode(JSON.stringify(value)).byteLength);
  };

  const visit = (input: unknown, depth: number): void => {
    if (refusal !== undefined) return;
    if (++nodes > 4096 || depth > 12) {
      refusal = "Oversized";

      return;
    }
    if (input === null) return add(4);
    switch (typeof input) {
      case "string":
        return text(input);
      case "boolean":
        return add(input ? 4 : 5);
      case "number":
        if (Number.isFinite(input)) return add(JSON.stringify(input).length);
        refusal = "Malformed";

        return;
      case "bigint":
        if (input < 0n || input > maximumInteger) refusal = "Malformed";
        else text(input.toString());

        return;
      case "object":
        break;
      case "undefined":
      case "symbol":
      case "function":
        refusal = "Malformed";

        return;
    }
    if (!Predicate.isObjectKeyword(input) || ancestors.has(input)) {
      refusal = "Malformed";

      return;
    }
    ancestors.add(input);
    const keys = Reflect.ownKeys(input);

    if (Array.isArray(input)) {
      if (input.length > 128 || keys.length !== input.length + 1) {
        refusal = "Oversized";

        return;
      }
      add(2 + Math.max(0, input.length - 1));
      for (let index = 0; index < input.length; index++) {
        const property = Object.getOwnPropertyDescriptor(input, String(index));

        if (property === undefined || !("value" in property)) {
          refusal = "Malformed";

          return;
        }
        visit(property.value, depth + 1);
        if (refusal !== undefined) return;
      }
    } else {
      const prototype: unknown = Object.getPrototypeOf(input);

      if (prototype !== null && prototype !== Object.prototype) {
        refusal = "Malformed";

        return;
      }
      if (keys.length > 64) {
        refusal = "Oversized";

        return;
      }
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== "string") {
          refusal = "Malformed";

          return;
        }
        const property = Object.getOwnPropertyDescriptor(input, key);

        if (property === undefined || !property.enumerable || !("value" in property)) {
          refusal = "Malformed";

          return;
        }
        text(key);
        add(1);
        visit(property.value, depth + 1);
        if (refusal !== undefined) return;
      }
    }
    ancestors.delete(input);
  };

  try {
    visit(value, 0);

    return refusal;
  } catch {
    return "Malformed";
  }
};

const immutable = <A>(value: A): A => {
  const freeze = (input: unknown): void => {
    if (!Predicate.isObjectKeyword(input) || Object.isFrozen(input)) return;
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  };

  freeze(value);

  return value;
};

/** One connection's bounded journal. Its captured Clock is the owner's original clock. */
export const makeStore = (configuration: {
  readonly clock: Clock.Clock;
  readonly originNanos: bigint;
  readonly identity: StoreIdentity;
  readonly limits: Retention;
}) => {
  const { clock, originNanos } = configuration;
  const identity = Object.freeze({ ...configuration.identity });
  const limits = Object.freeze({ ...configuration.limits });

  const entries: Array<Entry | undefined> = Array.from(
    { length: limits.maxEvents },
    () => undefined,
  );

  const readers = new Set<Reader>();
  const maximumAge = BigInt(Math.floor(limits.maxDurationMillis * 1_000_000));
  let head = 0;
  let size = 0;
  let retainedBytes = 0;
  let watermark = 0n;
  let evictedThrough = 0n;
  let evictedAt: bigint | undefined;
  let evicted = 0;
  let terminal: Terminal | null = null;

  const cursor = (sequence = watermark): Cursor => Object.freeze({ ...identity, sequence });

  const now = (): Stamp =>
    Object.freeze({
      clockId: identity.clockId,
      offsetNanos: clock.monotonicTimeNanosUnsafe() - originNanos,
    });

  const entry = (index: number) => entries[(head + index) % limits.maxEvents];

  const evict = () => {
    const oldest = entry(0);

    if (oldest === undefined) return;
    entries[head] = undefined;
    head = (head + 1) % limits.maxEvents;
    size--;
    retainedBytes -= oldest.bytes;
    evictedThrough = oldest.event.sequence;
    evictedAt = oldest.event.at.offsetNanos;
    evicted++;
  };

  const expire = () => {
    const current = now().offsetNanos;

    while (size > 0) {
      const oldest = entry(0);

      if (oldest === undefined || current - oldest.event.at.offsetNanos <= maximumAge) return;
      evict();
    }
  };

  const bounds = () => ({
    oldest: size === 0 ? null : cursor(entry(0)?.event.sequence),
    newest: size === 0 ? null : cursor(entry(size - 1)?.event.sequence),
    resumeAfter: cursor(),
    evictedThrough: cursor(evictedThrough),
  });

  const gap = (requested: Selector) => new TimelineGap({ requested, ...bounds() });

  const validate = (requested: Selector): TimelineError | undefined => {
    if ("sequence" in requested) {
      if (requested.storeId !== identity.storeId)
        return new TimelineCursorError({ reason: "Store", requested, current: cursor() });
      if (requested.clockId !== identity.clockId)
        return new TimelineCursorError({ reason: "Clock", requested, current: cursor() });
      if (requested.sequence > watermark)
        return new TimelineCursorError({ reason: "Future", requested, current: cursor() });
      if (requested.sequence < evictedThrough) return gap(requested);
    } else {
      if (requested.at.clockId !== identity.clockId)
        return new TimelineCursorError({ reason: "Clock", requested, current: cursor() });
      if (evictedAt !== undefined && requested.at.offsetNanos <= evictedAt) return gap(requested);
    }

    return undefined;
  };

  const normalize = (requested: unknown): Result.Result<Selector, TimelineError> => {
    if (metadataAdmission(requested, 2048) !== undefined)
      return Result.fail(new TimelineMalformed({}));
    const parsed = decodeSelector(requested, closed);

    if (Result.isFailure(parsed)) return Result.fail(new TimelineMalformed({}));
    const selected = immutable(parsed.success);
    const refusal = validate(selected);

    return refusal === undefined ? Result.succeed(selected) : Result.fail(refusal);
  };

  const viewTerminal = (view: View | undefined) => view?.terminal() ?? terminal;

  const matches = (event: Event, view: View | undefined) =>
    view === undefined ||
    (event.target?.pageId === view.pageId && event.target.generation === view.generation);

  const wake = () => {
    for (const reader of readers) {
      const pending = reader.wake;

      reader.wake = undefined;
      // Completing with void would synchronously run consumer work inside native publication.
      if (pending !== undefined) Deferred.doneUnsafe(pending, Effect.yieldNow);
    }
  };

  const append = (input: AppendInput): AppendResult => {
    if (terminal !== null) return { _tag: "Refused", reason: "Closed" };
    const refusal = metadataAdmission(input, limits.maxEventBytes);

    if (refusal !== undefined) return { _tag: "Refused", reason: refusal };
    const candidate = { ...input, version: 1, ...identity, sequence: watermark + 1n, at: now() };
    const decoded = decodeEvent(candidate, closed);

    if (Result.isFailure(decoded)) return { _tag: "Refused", reason: "Malformed" };
    const encoded = encodeEvent(decoded.success, closed);

    if (Result.isFailure(encoded)) return { _tag: "Refused", reason: "Malformed" };
    const bytes = utf8.encode(JSON.stringify(encoded.success)).byteLength;

    if (bytes > limits.maxEventBytes) return { _tag: "Refused", reason: "Oversized", bytes };
    const event = immutable(decoded.success);

    expire();
    while (size >= limits.maxEvents) evict();
    entries[(head + size) % limits.maxEvents] = { event, bytes };
    size++;
    retainedBytes += bytes;
    watermark = event.sequence;
    if (event.event._tag === "Terminal" && event.event.scope === "session")
      terminal = immutable({
        cursor: cursor(),
        at: event.at,
        scope: event.event.scope,
        reason: event.event.reason,
      });
    while (retainedBytes > limits.maxBytes) evict();
    wake();

    return { _tag: "Appended", event };
  };

  /** Closure is an owner fact even when retention cannot admit its terminal envelope. */
  const finish = (reason: TerminalReason): AppendResult => {
    const result = append({
      target: null,
      correlation: null,
      event: { _tag: "Terminal", scope: "session", reason },
    });

    if (terminal === null) {
      terminal = immutable({ cursor: cursor(), at: now(), scope: "session", reason });
      wake();
    }

    return result;
  };

  const snapshot = Effect.fnUntraced(function* (
    options?: SnapshotOptions,
    view?: View,
  ): Effect.fn.Return<Snapshot, TimelineError> {
    expire();
    let from: Selector | undefined;

    if (options !== undefined) {
      if (metadataAdmission(options, 2048) !== undefined) return yield* new TimelineMalformed({});
      const parsed = decodeSnapshotOptions(options, closed);

      if (Result.isFailure(parsed)) return yield* new TimelineMalformed({});
      from = parsed.success.from;
      if (from !== undefined) {
        const checked = normalize(from);

        if (Result.isFailure(checked)) return yield* checked.failure;
        from = checked.success;
      }
    }
    const events: Event[] = [];
    const ending = viewTerminal(view);

    for (let index = 0; index < size; index++) {
      const current = entry(index)?.event;

      if (current !== undefined && ending !== null && current.sequence > ending.cursor.sequence)
        break;
      if (current === undefined || !matches(current, view)) continue;
      if (
        from !== undefined &&
        ("sequence" in from
          ? current.sequence <= from.sequence
          : current.at.offsetNanos < from.at.offsetNanos)
      )
        continue;
      events.push(current);
    }

    return immutable({ events, ...bounds(), evicted, retainedBytes, terminal: ending });
  });

  const attach = (
    options: SubscriptionOptions = {},
  ): Result.Result<Subscription, TimelineError> => {
    expire();
    let sequence = watermark;
    let minimumAt: bigint | undefined;

    if (options.from !== undefined) {
      const selected = normalize(options.from);

      if (Result.isFailure(selected)) return Result.fail(selected.failure);
      if ("sequence" in selected.success) sequence = selected.success.sequence;
      else {
        minimumAt = selected.success.at.offsetNanos;
        sequence = evictedThrough;
      }
    }
    if (readers.size >= limits.maxSubscribers)
      return Result.fail(
        new TimelineLimit({ maximum: limits.maxSubscribers, observed: readers.size + 1 }),
      );

    const reader: Reader = {
      sequence,
      minimumAt,
      view: options.view,
      wake: undefined,
      released: false,
    };

    readers.add(reader);

    const release = () => {
      if (reader.released) return;
      reader.released = true;
      readers.delete(reader);
      const pending = reader.wake;

      reader.wake = undefined;
      if (pending !== undefined) Deferred.doneUnsafe(pending, Effect.yieldNow);
    };

    const pull: Subscription["pull"] = Effect.suspend(() => {
      expire();
      if (reader.sequence < evictedThrough) return Effect.fail(gap(cursor(reader.sequence)));
      if (reader.released) return Cause.done();
      const output: Event[] = [];
      const ending = viewTerminal(reader.view);

      for (let index = 0; index < size; index++) {
        const current = entry(index)?.event;

        if (current === undefined || current.sequence <= reader.sequence) continue;
        if (ending !== null && current.sequence > ending.cursor.sequence) break;
        reader.sequence = current.sequence;
        if (
          (reader.minimumAt === undefined || current.at.offsetNanos >= reader.minimumAt) &&
          matches(current, reader.view)
        )
          output.push(current);
        if (output.length >= 32) break;
      }
      if (output.length > 0) {
        const first = output[0];

        if (first !== undefined) return Effect.succeed([first, ...output.slice(1)]);
      }
      if (ending !== null && reader.sequence >= ending.cursor.sequence) return Cause.done();
      reader.wake ??= Deferred.makeUnsafe<void>();

      return Deferred.await(reader.wake).pipe(Effect.andThen(pull));
    });

    return Result.succeed({
      get cursor() {
        return cursor(reader.sequence);
      },
      pull,
      release,
    });
  };

  const subscribe = (
    options?: SubscriptionOptions,
  ): Effect.Effect<Subscription, TimelineError, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.suspend(() => Effect.fromResult(attach(options))),
      (subscription) => Effect.sync(subscription.release),
    );

  return { append, finish, snapshot, attach, subscribe, cursor, now };
};
