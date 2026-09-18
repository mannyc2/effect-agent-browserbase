import { Context, Effect, Layer, Schema, Stream } from "effect";
import { BrowserbaseError, DownloadMetadata, Identifier, SessionReference } from "./Types.ts";
import { decode, makeHttp, type BrowserbaseOptions, type Http } from "./internal/Http.ts";
import { makeProvider } from "./internal/Provider.ts";
import { deadlineAfter, nowMillis, within } from "./internal/Deadline.ts";

export interface DownloadPolicy {
  readonly maxBytes: number;
  readonly timeoutMillis?: number;
  readonly mimeTypes: ReadonlyArray<string>;
}
export interface DownloadListing {
  readonly downloads: ReadonlyArray<DownloadMetadata>;
  readonly total: number;
  readonly offset: number;
  readonly complete: boolean;
}
const Listing = Schema.Struct({
  downloads: Schema.Array(DownloadMetadata).check(Schema.isMaxLength(100)),
  total: Schema.Natural,
});

/** Website files are not session-recording MP4s. They retain their own provider download ID. */
export class BrowserbaseDownloads extends Context.Service<BrowserbaseDownloads, {
  readonly list: (reference: SessionReference, offset?: number) => Effect.Effect<DownloadListing, BrowserbaseError>;
  readonly metadata: (reference: SessionReference, downloadId: string) => Effect.Effect<DownloadMetadata, BrowserbaseError>;
  readonly stream: (reference: SessionReference, downloadId: string, policy: DownloadPolicy) => Stream.Stream<Uint8Array, BrowserbaseError>;
  readonly waitForNew: (reference: SessionReference, previousIds: ReadonlyArray<string>, timeoutMillis?: number) => Effect.Effect<ReadonlyArray<DownloadMetadata>, BrowserbaseError>;
}>()("@effect-agent/platform-browserbase/BrowserbaseDownloads") {
  static layer(options: BrowserbaseOptions) {
    return Layer.effect(this, makeHttp(options).pipe(Effect.map((http) => makeDownloads(http, options.projectId))));
  }
}

const makeDownloads = (http: Http, projectId: string): BrowserbaseDownloads["Service"] => {
  const provider = makeProvider(http, projectId);
  const list = Effect.fnUntraced(function* (ref: SessionReference, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) return yield* BrowserbaseError.make({ operation: "downloads-list", reason: "configuration" });
    yield* provider.metadata(ref);
    const raw = yield* http.json("GET", `/v1/downloads?sessionId=${encodeURIComponent(ref.sessionId)}&limit=100&offset=${offset}`).pipe(
      Effect.flatMap((value) => decode(Listing, value, "downloads-list")),
    );
    if (raw.downloads.some((d) => d.sessionId !== ref.sessionId) || new Set(raw.downloads.map((d) => d.id)).size !== raw.downloads.length) {
      return yield* BrowserbaseError.make({ operation: "downloads-list", reason: "malformed" });
    }
    return { ...raw, offset, complete: offset + raw.downloads.length >= raw.total };
  });
  const metadata = Effect.fnUntraced(function* (ref: SessionReference, id: string) {
    yield* decode(Identifier, id, "download-metadata");
    yield* provider.metadata(ref);
    const value = yield* http.json("GET", `/v1/downloads/${encodeURIComponent(id)}`).pipe(
      Effect.flatMap((raw) => decode(DownloadMetadata, raw, "download-metadata")),
    );
    if (value.id !== id || value.sessionId !== ref.sessionId) return yield* BrowserbaseError.make({ operation: "download-metadata", reason: "malformed" });
    return value;
  });
  const stream = (ref: SessionReference, id: string, policy: DownloadPolicy) => Stream.unwrap(Effect.gen(function* () {
    if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > 2 ** 31 - 1 ||
        policy.mimeTypes.length === 0 || policy.mimeTypes.length > 32) {
      return yield* BrowserbaseError.make({ operation: "download", reason: "configuration" });
    }
    const timeoutMillis = policy.timeoutMillis ?? 60_000;
    if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 600_000) {
      return yield* BrowserbaseError.make({ operation: "download", reason: "configuration" });
    }
    const deadline = yield* deadlineAfter(timeoutMillis);
    const file = yield* within(metadata(ref, id), deadline, "download");
    if (!policy.mimeTypes.includes(file.mimeType.toLowerCase())) return yield* BrowserbaseError.make({ operation: "download", reason: "content-type" });
    if (file.size > policy.maxBytes) return yield* BrowserbaseError.make({ operation: "download", reason: "limit" });
    let received = 0;
    return http.bytes(`/v1/downloads/${encodeURIComponent(id)}`, policy.maxBytes,
      ["application/octet-stream", file.mimeType.toLowerCase()], "download", timeoutMillis, deadline).pipe(
      Stream.tap((chunk) => Effect.sync(() => { received += chunk.byteLength; })),
      Stream.concat(Stream.fromEffect(Effect.suspend(() => received === file.size ? Effect.void :
        Effect.fail(BrowserbaseError.make({ operation: "download", reason: "malformed" })))).pipe(Stream.drain)),
    );
  }));
  const waitForNew = Effect.fnUntraced(function* (ref: SessionReference, previousIds: ReadonlyArray<string>, timeoutMillis = 30_000) {
    if (previousIds.length > 10_000 || !Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 300_000) {
      return yield* BrowserbaseError.make({ operation: "download-wait", reason: "configuration" });
    }
    const previous = new Set(previousIds);
    const deadline = yield* deadlineAfter(timeoutMillis);
    do {
      const result = yield* within(list(ref), deadline, "downloads-wait");
      // Never claim a complete candidate set from a partial listing.
      if (!result.complete) return yield* BrowserbaseError.make({ operation: "download-wait", reason: "limit" });
      const fresh = result.downloads.filter((d) => !previous.has(d.id));
      if (fresh.length > 0) return fresh;
      const remaining = deadline - (yield* nowMillis);
      if (remaining <= 0) break;
      yield* Effect.sleep(Math.min(500, remaining));
    } while ((yield* nowMillis) < deadline);
    return yield* BrowserbaseError.make({ operation: "download-wait", reason: "timeout" });
  });
  return { list, metadata, stream, waitForNew };
};
