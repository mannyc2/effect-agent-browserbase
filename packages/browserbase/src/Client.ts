import { Context, Effect, Layer, type Redacted, type Schema, type Stream } from "effect";

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

export type ClientMethod = "GET" | "POST" | "DELETE";

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
    readonly text: (
      path: string,
      maximum: number,
      types: ReadonlyArray<string>,
      operation: string,
    ) => Effect.Effect<string, ClientError>;
    readonly bytes: (
      path: string,
      maximum: number,
      types: ReadonlyArray<string>,
      operation: string,
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
>()("@effect-agent/browserbase/Client") {
  static layer(options: ClientOptions): Layer.Layer<BrowserbaseClient, ClientError> {
    return Layer.effect(
      BrowserbaseClient,
      makeTransport(options).pipe(
        Effect.map((client) => BrowserbaseClient.of(Object.freeze(client))),
      ),
    );
  }
}
