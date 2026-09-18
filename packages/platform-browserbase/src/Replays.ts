import { Clock, Context, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { BrowserbaseError, Identifier, RecordingPageReference, ReplayPage, SessionReference } from "./Types.ts";
import { decode, makeHttp, type BrowserbaseOptions, type Http } from "./internal/Http.ts";
import { makeProvider, terminal } from "./internal/Provider.ts";
import type { DownloadLimits } from "./Recordings.ts";

const Metadata = Schema.Struct({
  pageCount: Schema.Natural,
  pages: Schema.Array(Schema.Struct({
    pageId: Identifier, startTimeMs: Schema.Finite, endTimeMs: Schema.Finite,
    url: Schema.String.check(Schema.isMaxLength(16384)),
  })).check(Schema.isMaxLength(256)),
});

export interface ReplayAccess {
  readonly reference: RecordingPageReference;
  /** Temporary playback material for an authorized host route; never includes the API key. */
  readonly playlist: Redacted.Redacted<string>;
  readonly fetchedAtMillis: number;
  readonly mediaCount: number;
  /** Optional host proxy of an indexed URI from this exact playlist; no arbitrary URL parameter. */
  readonly media: (index: number, limits: DownloadLimits) => Stream.Stream<Uint8Array, BrowserbaseError>;
}

export class BrowserbaseReplays extends Context.Service<BrowserbaseReplays, {
  readonly metadata: (reference: SessionReference) => Effect.Effect<ReadonlyArray<ReplayPage>, BrowserbaseError>;
  readonly openPage: (reference: RecordingPageReference) => Effect.Effect<ReplayAccess, BrowserbaseError>;
}>()("@effect-agent/platform-browserbase/BrowserbaseReplays") {
  static layer(options: BrowserbaseOptions) {
    return Layer.effect(this, makeHttp(options).pipe(Effect.map((http) => makeReplays(http, options.projectId))));
  }
}

/** Media-playlist validation, not a player. Unsupported URI-bearing tags fail closed. */
const playlistUrls = (body: string, allowed: (url: string) => boolean): ReadonlyArray<string> => {
  const lines = body.split(/\r?\n/);
  if (lines[0] !== "#EXTM3U" || !lines.includes("#EXT-X-ENDLIST") || lines.length > 32768) {
    throw BrowserbaseError.make({ operation: "replay-playlist", reason: "malformed" });
  }
  const urls: string[] = [];
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.startsWith("#EXT-X-STREAM-INF") || line.startsWith("#EXT-X-MEDIA:") ||
        (line.startsWith("#EXT-X-KEY:") && line !== "#EXT-X-KEY:METHOD=NONE")) {
      throw BrowserbaseError.make({ operation: "replay-playlist", reason: "unsupported" });
    }
    let url: string | undefined;
    if (!line.startsWith("#")) url = line;
    else if (/URI\s*=/.test(line)) {
      if (!line.startsWith("#EXT-X-MAP:")) throw BrowserbaseError.make({ operation: "replay-playlist", reason: "unsupported" });
      const match = /(?:^|,)URI="([^"]+)"(?:,|$)/.exec(line.slice("#EXT-X-MAP:".length));
      if (match === null) throw BrowserbaseError.make({ operation: "replay-playlist", reason: "malformed" });
      url = match[1];
    }
    if (url !== undefined) {
      if (!allowed(url) || urls.length >= 16384) throw BrowserbaseError.make({ operation: "replay-playlist", reason: "unsafe-url" });
      urls.push(url);
    }
  }
  if (urls.length === 0) throw BrowserbaseError.make({ operation: "replay-playlist", reason: "malformed" });
  return urls;
};

const makeReplays = (http: Http, projectId: string): BrowserbaseReplays["Service"] => {
  const provider = makeProvider(http, projectId);
  const metadata = Effect.fnUntraced(function* (ref: SessionReference) {
    const session = yield* provider.metadata(ref);
    if (!terminal(session.status)) return yield* BrowserbaseError.make({ operation: "replay", reason: "active" });
    const raw = yield* http.json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/replays`).pipe(
      Effect.flatMap((value) => decode(Metadata, value, "replay-metadata")),
    );
    if (raw.pageCount !== raw.pages.length || new Set(raw.pages.map((p) => p.pageId)).size !== raw.pages.length ||
        raw.pages.some((p) => p.startTimeMs < 0 || p.endTimeMs < p.startTimeMs)) {
      return yield* BrowserbaseError.make({ operation: "replay-metadata", reason: "malformed" });
    }
    return raw.pages.map((p) => ReplayPage.make({ pageId: p.pageId, startTimeMs: p.startTimeMs, endTimeMs: p.endTimeMs }));
  });
  const openPage = Effect.fnUntraced(function* (ref: RecordingPageReference) {
    yield* decode(RecordingPageReference, ref, "replay");
    const pages = yield* metadata(ref.session);
    if (!pages.some((p) => p.pageId === ref.pageId)) return yield* BrowserbaseError.make({ operation: "replay", reason: "not-found" });
    const body = yield* http.text(`/v1/sessions/${encodeURIComponent(ref.session.sessionId)}/replays/${encodeURIComponent(ref.pageId)}`,
      1024 * 1024, ["application/vnd.apple.mpegurl", "application/x-mpegurl"], "replay-playlist");
    const urls = yield* Effect.try({
      try: () => playlistUrls(body, http.validateMediaUrl),
      catch: () => BrowserbaseError.make({ operation: "replay-playlist", reason: "malformed" }),
    });
    return {
      reference: ref,
      playlist: Redacted.make(body),
      fetchedAtMillis: yield* Clock.currentTimeMillis,
      mediaCount: urls.length,
      media: (index: number, limits: DownloadLimits) => {
        const url = Number.isSafeInteger(index) ? urls[index] : undefined;
        return url === undefined ? Stream.fail(BrowserbaseError.make({ operation: "replay-media", reason: "not-found" })) :
          http.media(Redacted.make(url), limits.maxBytes, ["video/mp4", "video/iso.segment", "application/octet-stream"], limits.timeoutMillis);
      },
    };
  });
  return { metadata, openPage };
};
