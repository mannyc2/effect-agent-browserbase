import { Config, Context, Effect, Layer, type Redacted, type Schema, type Stream } from "effect";

import type { ClientError } from "./Errors.ts";
import { makeTransport } from "./internal/http/Transport.ts";

/** Account authority only. Launch recipes and browser-operation policy do not belong here. */
export interface ClientOptions {
  readonly projectId: string;
  readonly apiKey: Redacted.Redacted<string>;
  /** Exact HTTPS origins approved for credential-free media/artifact transfers. */
  readonly artifactOrigins?: ReadonlyArray<string>;
  readonly requestTimeoutMillis?: number;
}

export type ClientMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One bounded in-memory file part. A filesystem path is never a transport input. */
export interface MultipartFile {
  readonly field: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Upload bounds are caller-owned; an omitted timeout keeps the 60-second default. */
export interface UploadLimits {
  readonly maxBytes: number;
  readonly timeoutMillis?: number;
}

/**
 * One immutable Browserbase account and approved transport, shared by every resource Layer.
 * Constructing the Layer performs no request and never loads the native browser peer.
 */
export class BrowserbaseClient extends Context.Service<
  BrowserbaseClient,
  {
    readonly projectId: string;
    readonly json: (
      method: ClientMethod,
      path: string,
      body?: Schema.Json,
      outerDeadline?: number,
    ) => Effect.Effect<Schema.Json, ClientError>;
    readonly noContent: (
      method: Exclude<ClientMethod, "GET">,
      path: string,
      body?: Schema.Json,
      outerDeadline?: number,
    ) => Effect.Effect<void, ClientError>;
    /** One bounded multipart mutation. A lost reply stays unknown and is never retried. */
    readonly upload: (
      path: string,
      part: MultipartFile,
      limits: UploadLimits,
      outerDeadline?: number,
    ) => Effect.Effect<Schema.Json, ClientError>;
    readonly text: (
      path: string,
      maximum: number,
      types: ReadonlyArray<string>,
    ) => Effect.Effect<string, ClientError>;
    readonly bytes: (
      path: string,
      maximum: number,
      types: ReadonlyArray<string>,
      timeoutMillis?: number,
      outerDeadline?: number,
    ) => Stream.Stream<Uint8Array, ClientError>;
    readonly media: (
      url: Redacted.Redacted<string>,
      maximum: number,
      types: ReadonlyArray<string>,
      timeoutMillis?: number,
      outerDeadline?: number,
    ) => Stream.Stream<Uint8Array, ClientError>;
    readonly validateMediaUrl: (value: string) => boolean;
  }
>()("effect-browserbase/Client") {
  static layer(options: ClientOptions): Layer.Layer<BrowserbaseClient, ClientError> {
    return Layer.effect(
      BrowserbaseClient,
      makeTransport(options).pipe(
        Effect.map((client) => BrowserbaseClient.of(Object.freeze(client))),
      ),
    );
  }

  /**
   * Account authority from the application's `ConfigProvider` (the environment by default):
   * `BROWSERBASE_PROJECT_ID` and a redacted `BROWSERBASE_API_KEY`. Transport options stay
   * explicit. Configuration is read when the Layer is built, never at import.
   */
  static layerConfig(
    options: Omit<ClientOptions, "projectId" | "apiKey"> = {},
  ): Layer.Layer<BrowserbaseClient, ClientError | Config.ConfigError> {
    return Layer.unwrap(
      Effect.gen(function* () {
        const projectId = yield* Config.String("BROWSERBASE_PROJECT_ID");
        const apiKey = yield* Config.Redacted("BROWSERBASE_API_KEY");

        return BrowserbaseClient.layer({ ...options, projectId, apiKey });
      }),
    );
  }
}
