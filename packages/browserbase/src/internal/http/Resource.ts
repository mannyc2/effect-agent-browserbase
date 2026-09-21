import { Effect, Schema } from "effect";

import type { BrowserbaseClient, ClientMethod } from "../../Client.ts";
import type { ClientError } from "../../Errors.ts";

type Reason = ClientError["reason"];
type Outcome = NonNullable<ClientError["outcome"]>;

export interface RequestFailure<Operation extends string> {
  readonly operation: Operation;
  readonly reason: Reason;
  readonly outcome?: Outcome;
  readonly status?: number;
  readonly retryAfterMillis?: number;
}

/**
 * The shared shape of every control-plane resource: strict input decoding, tolerant reply
 * decoding, and one mapping from transport failures into the resource's own error.
 */
export const resource = <E extends { readonly operation: string }>(
  client: BrowserbaseClient["Service"],
  make: (failure: RequestFailure<E["operation"]>) => E,
) => {
  type Operation = E["operation"];

  const fromClient = (operation: Operation) => (error: ClientError) =>
    make({
      operation,
      reason: error.reason,
      ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
    });

  const configuration = (operation: Operation) =>
    make({ operation, reason: "configuration", outcome: "undispatched" });

  const malformed = (operation: Operation, mutation: boolean) =>
    make({ operation, reason: "malformed", ...(mutation ? { outcome: "unknown" } : {}) });

  /** Rejects unknown or invalid caller input before any request is built. */
  const input = <A>(
    schema: Schema.Codec<A, unknown, never, never>,
    value: unknown,
    operation: Operation,
  ): Effect.Effect<A, E> =>
    Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => configuration(operation)),
    );

  const request = <A>(
    method: ClientMethod,
    path: string,
    reply: Schema.Codec<A, unknown, never, never>,
    operation: Operation,
    body?: Schema.Json,
  ): Effect.Effect<A, E> =>
    client.json(method, path, body).pipe(
      Effect.mapError(fromClient(operation)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(reply)(raw).pipe(
          Effect.mapError(() => malformed(operation, method !== "GET")),
        ),
      ),
    );

  const remove = (path: string, operation: Operation): Effect.Effect<void, E> =>
    client.noContent("DELETE", path).pipe(Effect.mapError(fromClient(operation)));

  const segment = (id: string) => encodeURIComponent(id);

  const query = (entries: Record<string, string | number | boolean | undefined>) => {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(entries))
      if (value !== undefined) search.set(key, String(value));

    return search.size === 0 ? "" : `?${search}`;
  };

  return { fromClient, configuration, malformed, input, request, remove, segment, query, make };
};
