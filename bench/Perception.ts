/**
 * Bench-only client for one explicitly started local perception process. The process owns models;
 * trial workers own screenshots and browser mutations. No request starts a model or retries work.
 */
import { createHash } from "node:crypto";

import { Context, Effect, Layer, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export const ocrDataSha256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2";
export const omniRevision = "f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4";
export const holoRevision = "44b125965ebefea6c04958f972a0219cff36e90d";
export const captionProcessorRevision = "5ca5edf5bd017b9919c05d08aebef5e4c7ac3bac";
export const captionCodeRevision = "f6c1a25888ffc1d945ee8a1a77ac833c7303d46e";

export const parsePreprocessing =
  "v3-top-left1280-conf005-nms045+tesseract-eng-psm11+florence64-caption20-v1";

export const groundPreprocessing =
  "holo2-smart-resize32-max1048576-thinking-off-json1000-tokens32-v1";

export const maxImageBytes = 5 * 1024 * 1024;
export const maxElements = 256;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const Dimension = PositiveInt.check(Schema.isLessThanOrEqualTo(4096));
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const PageId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Stamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const Observation = Schema.Struct({
  sha256: Hash,
  width: Dimension,
  height: Dimension,
  page: PageId,
  at: Stamp,
});

export type Observation = typeof Observation.Type;

export const Image = Schema.Struct({
  ...Observation.fields,
  data: Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(maxImageBytes)),
  mimeType: Schema.Literal("image/jpeg"),
});

export type Image = typeof Image.Type;

const Device = Schema.Literals(["cpu", "cuda"]);
const Mode = Schema.Literals(["parse", "ground"]);

const Runtime = Schema.Struct({
  python: Schema.String.check(Schema.isMaxLength(40)),
  torch: Schema.String.check(Schema.isMaxLength(40)),
  transformers: Schema.String.check(Schema.isMaxLength(40)),
  ocr: Schema.String.check(Schema.isMaxLength(40)),
});

const ParseProvenance = Schema.Struct({
  modelId: Schema.Literal("microsoft/OmniParser-v2.0"),
  revision: Schema.Literal(omniRevision),
  captionProcessorRevision: Schema.Literal(captionProcessorRevision),
  captionCodeRevision: Schema.Literal(captionCodeRevision),
  ocrDataSha256: Schema.Literal(ocrDataSha256),
  preprocessing: Schema.Literal(parsePreprocessing),
  device: Device,
  runtime: Runtime,
});

const GroundProvenance = Schema.Struct({
  modelId: Schema.Literal("Hcompany/Holo2-4B"),
  revision: Schema.Literal(holoRevision),
  preprocessing: Schema.Literal(groundPreprocessing),
  device: Schema.Literal("cuda"),
  runtime: Runtime,
});

export const Provenance = Schema.Union([ParseProvenance, GroundProvenance]);
export type Provenance = typeof Provenance.Type;

const Coordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Box = Schema.Struct({ x0: Coordinate, y0: Coordinate, x1: Coordinate, y1: Coordinate });

export const Element = Schema.Struct({
  id: PositiveInt,
  bbox: Box,
  kind: Schema.Literals(["text", "icon"]),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  interactable: Schema.Boolean,
});

export type Element = typeof Element.Type;

export const ParsedFrame = Schema.Struct({
  observation: Observation,
  provenance: ParseProvenance,
  elements: Schema.Array(Element).check(Schema.isMaxLength(maxElements)),
});

export type ParsedFrame = typeof ParsedFrame.Type;

export const GroundedPoint = Schema.Struct({
  observation: Observation,
  provenance: GroundProvenance,
  x: Coordinate,
  y: Coordinate,
});

export type GroundedPoint = typeof GroundedPoint.Type;

export const Failure = Schema.Literals([
  "MissingWeights",
  "RuntimeUnavailable",
  "GpuCapacity",
  "WrongMode",
  "Busy",
  "Timeout",
  "InvalidImage",
  "InvalidOutput",
  "IdentityMismatch",
  "LimitExceeded",
  "Unavailable",
]);

export type Failure = typeof Failure.Type;

export class PerceptionError extends Schema.TaggedError<PerceptionError>()("PerceptionError", {
  reason: Failure,
}) {}

export const Status = Schema.Struct({
  mode: Mode,
  ready: Schema.Boolean,
  reason: Schema.NullOr(Failure),
  provenance: Provenance,
  requiredFreeMiB: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  gpuFreeMiB: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type Status = typeof Status.Type;

export interface Options {
  /** An explicit loopback origin. The client refuses credentials, paths, queries and redirects. */
  readonly origin: string;
  readonly timeoutMs?: number;
}

export class Perception extends Context.Service<
  Perception,
  {
    readonly parse: (image: Image) => Effect.Effect<ParsedFrame, PerceptionError>;
    readonly ground: (image: Image, what: string) => Effect.Effect<GroundedPoint, PerceptionError>;
    readonly status: Effect.Effect<Status, PerceptionError>;
  }
>()("bench/Perception") {
  static readonly layer = (options: Options) =>
    Layer.effect(Perception, make(options)).pipe(Layer.provide(FetchHttpClient.layer));
}

const fail = (reason: Failure) => new PerceptionError({ reason });

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, reason: Failure) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => fail(reason)),
  );

const sameObservation = (left: Observation, right: Observation) =>
  left.sha256 === right.sha256 &&
  left.width === right.width &&
  left.height === right.height &&
  left.page === right.page &&
  left.at === right.at;

const snapshot = Effect.fnUntraced(function* (input: Image) {
  const image = yield* decode(Image, input, "InvalidImage");
  // Copy before hashing and encoding: a caller cannot change an in-flight observation's bytes.
  const data = Uint8Array.from(image.data);

  if (image.width * image.height > 4096 * 2160) return yield* fail("LimitExceeded");
  if (createHash("sha256").update(data).digest("hex") !== image.sha256)
    return yield* fail("IdentityMismatch");

  return { ...image, data };
});

export const make = Effect.fnUntraced(function* (options: Options) {
  const origin = yield* Effect.try({
    try: () => new URL(options.origin),
    catch: () => fail("Unavailable"),
  });

  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  )
    return yield* fail("Unavailable");
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    return yield* fail("LimitExceeded");
  const client = yield* HttpClient.HttpClient;

  const request = Effect.fnUntraced(
    function* (path: string, body?: unknown) {
      const request =
        body === undefined
          ? HttpClientRequest.get(origin.origin + path)
          : HttpClientRequest.post(origin.origin + path).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            );

      const response = yield* client.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(() => fail("Unavailable")),
      );

      const bytes = yield* response.stream.pipe(
        Stream.mapError(() => fail("Unavailable")),
        Stream.runFoldEffect(
          () => new Uint8Array(),
          (previous, chunk) => {
            if (previous.byteLength + chunk.byteLength > 256 * 1024)
              return Effect.fail(fail("LimitExceeded"));
            const next = new Uint8Array(previous.byteLength + chunk.byteLength);

            next.set(previous);
            next.set(chunk, previous.byteLength);

            return Effect.succeed(next);
          },
        ),
      );

      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => fail("InvalidOutput"),
      });

      const value = yield* decode(Schema.fromJsonString(Schema.Unknown), text, "InvalidOutput");

      if (response.status !== 200) {
        const error = yield* decode(PerceptionError, value, "InvalidOutput");

        return yield* error;
      }

      return value;
    },
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(fail("Timeout")),
    }),
  );

  const wire = (image: Image) => ({
    ...image,
    data: Buffer.from(image.data).toString("base64"),
  });

  const parse = Effect.fnUntraced(function* (input: Image) {
    const image = yield* snapshot(input);

    const result = yield* decode(
      ParsedFrame,
      yield* request("/parse", wire(image)),
      "InvalidOutput",
    );

    if (!sameObservation(image, result.observation)) return yield* fail("IdentityMismatch");
    for (const [index, element] of result.elements.entries()) {
      const box = element.bbox;

      if (
        element.id !== index + 1 ||
        box.x0 >= box.x1 ||
        box.y0 >= box.y1 ||
        box.x1 > image.width ||
        box.y1 > image.height ||
        element.interactable !== (element.kind === "icon")
      )
        return yield* fail("InvalidOutput");
    }

    return result;
  });

  const ground = Effect.fnUntraced(function* (input: Image, what: string) {
    const image = yield* snapshot(input);

    const target = yield* decode(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      what,
      "LimitExceeded",
    );

    if (target.trim() === "") return yield* fail("InvalidOutput");

    const result = yield* decode(
      GroundedPoint,
      yield* request("/ground", { ...wire(image), what: target }),
      "InvalidOutput",
    );

    if (!sameObservation(image, result.observation)) return yield* fail("IdentityMismatch");
    if (result.x >= image.width || result.y >= image.height) return yield* fail("InvalidOutput");

    return result;
  });

  const status = Effect.gen(function* () {
    const status = yield* decode(Status, yield* request("/status"), "InvalidOutput");

    if (
      status.ready !== (status.reason === null) ||
      (status.mode === "parse") !== (status.provenance.modelId === "microsoft/OmniParser-v2.0")
    )
      return yield* fail("InvalidOutput");

    return status;
  });

  return Perception.of({ parse, ground, status });
});
