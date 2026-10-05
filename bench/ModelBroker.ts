// Workers keep browser ownership; one parent owns every paid request and its shared admission.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { OpenRouterClient } from "@effect/ai-openrouter";
import * as Generated from "@effect/ai-openrouter/Generated";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import * as Diagnostics from "./Diagnostics.ts";
import * as Native from "./Native.ts";
import type { Account, Reasoning } from "./run.ts";

export const maximumRequestBytes = 16 * 1024 * 1024;

export class BrokerError extends Schema.TaggedError<BrokerError>()("ModelBrokerError", {
  code: Schema.Literals(["Listen", "Read", "TooLarge", "Invalid", "Closed", "Unpriced"]),
}) {}

export interface ImageMetrics {
  readonly count: number;
  readonly decodedBytes: number;
  readonly unknown: number;
  readonly dimensions: ReadonlyArray<{
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly bytes: number;
  }>;
}

export interface Metrics {
  readonly images: ImageMetrics;
  readonly failure: Diagnostics.Failure | null;
}

/** Read encoded image dimensions without keeping pixels or trusting a declared data URL. */
export const imageDimensions = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);

    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (data.length < 4 || data[0] !== 255 || data[1] !== 216) return undefined;

  let offset = 2;

  while (offset + 4 <= data.length) {
    if (data[offset] !== 255) return undefined;
    const marker = data[offset + 1];

    if (marker === undefined || marker === 217 || marker === 218) return undefined;
    if (marker === 255) {
      offset += 1;
      continue;
    }
    if (marker === 1 || (marker >= 208 && marker <= 215)) {
      offset += 2;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);

    if (length < 2 || offset + length + 2 > data.length) return undefined;
    if (
      (marker >= 192 && marker <= 195) ||
      (marker >= 197 && marker <= 199) ||
      (marker >= 201 && marker <= 203) ||
      (marker >= 205 && marker <= 207)
    ) {
      if (length < 8) return undefined;
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);

      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length + 2;
  }

  return undefined;
};

export const imagesIn = (request: Generated.ChatRequest): ImageMetrics => {
  let count = 0;
  let decodedBytes = 0;
  let unknown = 0;

  const dimensions = new Map<
    string,
    { width: number; height: number; count: number; bytes: number }
  >();

  for (const message of request.messages) {
    const content = message.content;

    if (content === undefined || content === null || typeof content === "string") continue;
    for (const part of content) {
      if (part.type !== "image_url") continue;
      count += 1;

      const matched = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(
        part.image_url.url,
      );

      const encoded = matched?.[1];

      if (encoded === undefined) {
        unknown += 1;
        continue;
      }
      const bytes = Buffer.from(encoded, "base64");
      const size = imageDimensions(bytes);

      decodedBytes += bytes.length;
      if (size === undefined) {
        unknown += 1;
        continue;
      }
      const key = String(size.width) + "x" + size.height;
      const previous = dimensions.get(key);

      dimensions.set(key, {
        ...size,
        count: (previous?.count ?? 0) + 1,
        bytes: (previous?.bytes ?? 0) + bytes.length,
      });
    }
  }

  return { count, decodedBytes, unknown, dimensions: [...dimensions.values()] };
};

const nativeImages = (request: Native.Request): ImageMetrics => {
  const object = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
  const list = Schema.is(Schema.Array(Schema.Unknown));
  const urls: Array<string> = [];

  for (const item of request.input) {
    const content = item.content;

    if (list(content))
      for (const part of content) {
        if (object(part) && part.type === "input_image" && typeof part.image_url === "string")
          urls.push(part.image_url);
      }
    if (
      item.type === "computer_call_output" &&
      object(item.output) &&
      typeof item.output.image_url === "string"
    )
      urls.push(item.output.image_url);
  }

  return imagesIn({
    model: request.model,
    messages: [
      { role: "user", content: urls.map((url) => ({ type: "image_url", image_url: { url } })) },
    ],
  });
};

const emptyImages: ImageMetrics = { count: 0, decodedBytes: 0, unknown: 0, dimensions: [] };

const addImages = (before: ImageMetrics, next: ImageMetrics): ImageMetrics => {
  const dimensions = new Map<
    string,
    { width: number; height: number; count: number; bytes: number }
  >();

  for (const size of [...before.dimensions, ...next.dimensions]) {
    const key = String(size.width) + "x" + size.height;
    const old = dimensions.get(key);

    dimensions.set(key, {
      width: size.width,
      height: size.height,
      count: (old?.count ?? 0) + size.count,
      bytes: (old?.bytes ?? 0) + size.bytes,
    });
  }

  return {
    count: before.count + next.count,
    decodedBytes: before.decodedBytes + next.decodedBytes,
    unknown: before.unknown + next.unknown,
    dimensions: [...dimensions.values()],
  };
};

const body = (request: IncomingMessage) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = [];
      let size = 0;

      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));

        size += bytes.length;
        if (size > maximumRequestBytes) throw new BrokerError({ code: "TooLarge" });
        chunks.push(bytes);
      }

      return Buffer.concat(chunks).toString("utf8");
    },
    catch: (error) => (Schema.is(BrokerError)(error) ? error : new BrokerError({ code: "Read" })),
  });

const respond = (response: ServerResponse, status: number, value: unknown) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};

const reject = (response: ServerResponse, status: number) =>
  respond(response, status, {
    error: { message: "Benchmark model admission failed.", code: status },
  });

export interface Registration {
  readonly model: string;
  readonly reasoning: Reasoning;
  readonly account: Account;
  /** The actual pinned OpenRouter client wrapped by the parent admission ledger. */
  readonly client: OpenRouterClient.Service;
  readonly timeoutMillis: number;
  readonly native?:
    | ((request: Native.Request) => Effect.Effect<Native.Reply, Native.NativeError>)
    | undefined;
}

interface Route {
  readonly registration: Registration;
  readonly pending: Set<Promise<void>>;
  active: boolean;
  images: ImageMetrics;
  failure: Diagnostics.Failure | null;
}

/** A loopback-only broker. Raw responses cross back to the real worker SDK and are never saved. */
export const make = Effect.gen(function* () {
  const routes = new Map<string, Route>();

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const matched = /^\/([a-f0-9]{48})\/(?:chat\/completions|responses)$/.exec(request.url ?? "");
    const key = matched?.[1];
    const route = key === undefined ? undefined : routes.get(key);

    if (request.method !== "POST" || route === undefined) {
      reject(response, 404);
      request.resume();

      return;
    }
    if (route.active) {
      reject(response, 409);
      request.resume();

      return;
    }
    route.active = true;
    const controller = new AbortController();

    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };

    request.once("aborted", abort);
    response.once("close", abort);

    const program = Effect.gen(function* () {
      const text = yield* body(request);

      if (request.url?.endsWith("/responses") === true) {
        if (route.registration.native === undefined)
          return yield* new BrokerError({ code: "Invalid" });

        const input = yield* Schema.decodeEffect(Schema.fromJsonString(Native.RequestSchema))(
          text,
        ).pipe(Effect.mapError(() => new BrokerError({ code: "Invalid" })));

        if (
          input.model !== route.registration.model ||
          input.reasoning.effort !== route.registration.reasoning
        )
          return yield* new BrokerError({ code: "Invalid" });
        const before = yield* route.registration.account.snapshot;
        const result = yield* route.registration.native(input).pipe(Effect.exit);
        const after = yield* route.registration.account.snapshot;

        if (after.calls > before.calls) route.images = addImages(route.images, nativeImages(input));
        if (Exit.isFailure(result)) {
          route.failure ??= Diagnostics.failure(result.cause);

          return yield* Effect.failCause(result.cause);
        }
        if (after.uncertainCalls > 0) return yield* new BrokerError({ code: "Unpriced" });
        respond(response, 200, result.value);

        return;
      }

      const input = yield* Schema.decodeEffect(Schema.fromJsonString(Generated.ChatRequest))(
        text,
      ).pipe(Effect.mapError(() => new BrokerError({ code: "Invalid" })));

      if (
        input.model !== route.registration.model ||
        input.stream === true ||
        input.reasoning?.effort !== route.registration.reasoning
      )
        return yield* new BrokerError({ code: "Invalid" });

      const before = yield* route.registration.account.snapshot;

      const result = yield* route.registration.client
        .createChatCompletion(input)
        .pipe(Effect.timeout(route.registration.timeoutMillis), Effect.exit);

      const after = yield* route.registration.account.snapshot;

      if (after.calls > before.calls) route.images = addImages(route.images, imagesIn(input));
      if (Exit.isFailure(result)) {
        route.failure ??= Diagnostics.failure(result.cause);

        return yield* Effect.failCause(result.cause);
      }

      if (after.uncertainCalls > 0) return yield* new BrokerError({ code: "Unpriced" });

      // The provider receipt was decoded and settled by the parent before this SDK response
      // returns to the child for text/object/tool conversion.
      respond(response, 200, result.value[0]);
    });

    try {
      const result = await Effect.runPromiseExit(
        program.pipe(Effect.timeout(route.registration.timeoutMillis)),
        { signal: controller.signal },
      );

      if (Exit.isFailure(result)) {
        route.failure ??= Diagnostics.failure(result.cause);
        if (request.url?.endsWith("/responses") === true) {
          const cause = Cause.findErrorOption(result.cause);
          const error = Option.isSome(cause) ? cause.value : undefined;

          const code = Schema.is(Native.NativeError)(error)
            ? error.code
            : Schema.is(BrokerError)(error) && error.code === "Unpriced"
              ? "UnpricedResponse"
              : "RequestUncertain";

          respond(response, 502, { code });
        } else reject(response, 502);
      }
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      route.active = false;
    }
  };

  const server = createServer((request, response) => {
    const matched = /^\/([a-f0-9]{48})\/(?:chat\/completions|responses)$/.exec(request.url ?? "");
    const route = matched?.[1] === undefined ? undefined : routes.get(matched[1]);

    const pending = handle(request, response).catch(() => {
      reject(response, 502);
    });

    route?.pending.add(pending);
    void pending.then(
      () => {
        route?.pending.delete(pending);
      },
      () => {
        route?.pending.delete(pending);
      },
    );
  });

  const port = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<number>((resolve, rejectListen) => {
          const failed = () => rejectListen(new BrokerError({ code: "Listen" }));

          server.once("error", failed);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", failed);
            const address = server.address();

            if (address === null || typeof address === "string") {
              rejectListen(new BrokerError({ code: "Listen" }));

              return;
            }
            resolve(address.port);
          });
        }),
      catch: () => new BrokerError({ code: "Listen" }),
    }),
    () =>
      Effect.promise(async () => {
        await Promise.all([...routes.values()].flatMap((route) => [...route.pending]));
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }),
  );

  return {
    register: (registration: Registration) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const key = randomBytes(24).toString("hex");

          const route: Route = {
            registration,
            pending: new Set(),
            active: false,
            images: emptyImages,
            failure: null,
          };

          routes.set(key, route);

          return {
            // This capability is sent only over the worker's private stdin, never into a record.
            apiUrl: "http://127.0.0.1:" + port + "/" + key,
            metrics: Effect.sync<Metrics>(() => ({
              images: route.images,
              failure: route.failure,
            })),
            close: Effect.promise(async () => {
              routes.delete(key);
              await Promise.all(route.pending);
            }),
          };
        }),
        (registration) => registration.close,
      ),
  };
});
