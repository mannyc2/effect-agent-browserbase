import { Effect, Schema } from "effect";

import type * as Bootstrap from "../../Bootstrap.ts";
import { BrowserError, InitializationError } from "../../Errors.ts";
import { Identifier } from "../../References.ts";

const Invoke = Symbol("BrowserbaseBindingRegistration");
const issued = new WeakSet<object>();

export const Origin = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);

        return (
          ["http:", "https:"].includes(url.protocol) &&
          url.origin === value &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    },
    { title: "an exact http(s) origin" },
  ),
);

export const FailureMode = Schema.Literals(["reject-call", "fail-session"]);

const metadataSchema = Schema.Struct({
  name: Identifier,
  origins: Schema.Array(Origin).check(
    Schema.isMaxLength(16),
    Schema.isUnique(),
    Schema.makeFilter((origins) => origins.length > 0, { title: "at least one allowed origin" }),
  ),
  maxConcurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxInputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 })),
  maxOutputBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 * 1024 * 1024 })),
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
  failureMode: FailureMode,
});

type Metadata = typeof metadataSchema.Type;

export interface Registration<E, R> extends Metadata {
  readonly [Invoke]: (
    text: string,
    check: Effect.Effect<void, InitializationError>,
  ) => Effect.Effect<string, E | InitializationError, R>;
}

/** Retain an issued live capability at schema boundaries; a copied shape is not authority. */
export const schema = Schema.declare<Registration<unknown, unknown>>(
  (value): value is Registration<unknown, unknown> =>
    typeof value === "object" && value !== null && issued.has(value),
  { title: "an issued Browserbase binding registration" },
);

const issue = <E, R>(
  metadata: Metadata,
  invoke: Registration<E, R>[typeof Invoke],
): Registration<E, R> => {
  const registration = Object.freeze({
    ...metadata,
    origins: Object.freeze([...metadata.origins]),
    [Invoke]: invoke,
  });

  issued.add(registration);

  return registration;
};

/** Pack heterogeneous codecs and handlers while their concrete input/output types are known. */
export const make = <I, IEncoded, O, OEncoded, E, R>(
  options: Bootstrap.BindingOptions<I, IEncoded, O, OEncoded, E, R>,
): Registration<E, R> => {
  const metadata = Schema.decodeSync(metadataSchema)(options);
  const { input, output, handle } = options;

  if (!Schema.isSchema(input) || !Schema.isSchema(output) || typeof handle !== "function") {
    throw new TypeError("Invalid binding registration");
  }

  const fail = (reason: "input" | "output") =>
    InitializationError.make({ operation: "callback", step: metadata.name, reason });

  return issue(
    metadata,
    Effect.fnUntraced(function* (text, check) {
      if (new TextEncoder().encode(text).length > metadata.maxInputBytes)
        return yield* fail("input");

      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(input))(text).pipe(
        Effect.catchCause(() => Effect.fail(fail("input"))),
      );

      yield* check;
      const value = yield* Effect.suspend(() => handle(decoded));

      const encoded = yield* Schema.encodeEffect(output)(value).pipe(
        Effect.catchCause(() => Effect.fail(fail("output"))),
      );

      const json = yield* Schema.decodeUnknownEffect(Schema.Json)(encoded).pipe(
        Effect.catchCause(() => Effect.fail(fail("output"))),
      );

      const result = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(json).pipe(
        Effect.catchCause(() => Effect.fail(fail("output"))),
      );

      if (new TextEncoder().encode(result).length > metadata.maxOutputBytes)
        return yield* fail("output");

      return result;
    }),
  );
};

/** Authentication is identity-based even when a caller copies every enumerable field/symbol. */
export const snapshot = Effect.fnUntraced(function* <E, R>(
  registration: Registration<E, R>,
): Effect.fn.Return<Registration<E, R>, BrowserError> {
  const invalid = () =>
    BrowserError.make({ operation: "configure", reason: "configuration", outcome: "undispatched" });

  if (!issued.has(registration)) return yield* invalid();

  const metadata = yield* Schema.decodeEffect(metadataSchema)(registration).pipe(
    Effect.mapError(invalid),
  );

  return issue(metadata, registration[Invoke]);
});

export const invoke = <E, R>(
  registration: Registration<E, R>,
  text: string,
  check: Effect.Effect<void, InitializationError>,
): Effect.Effect<string, E | InitializationError, R> => registration[Invoke](text, check);
