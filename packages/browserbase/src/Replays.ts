import { Clock, Context, Effect, Layer, Redacted, Schema, Stream } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { ArtifactError, type ClientError } from "./Errors.ts";
import { requireTerminalSession } from "./internal/artifact/Authorization.ts";
import { transferPolicy } from "./internal/artifact/TransferPolicy.ts";
import { Identifier, type SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import {
  type ArtifactTransferPolicy as DownloadLimits,
  RecordingPageReference,
  ReplayPage,
} from "./Transfers.ts";

const Metadata = Schema.Struct({
  pageCount: Schema.Natural,
  pages: Schema.Array(
    Schema.Struct({
      pageId: Identifier,
      startTimeMs: Schema.Finite,
      endTimeMs: Schema.Finite,
      url: Schema.String.check(Schema.isMaxLength(16384)),
    }),
  ).check(Schema.isMaxLength(256)),
});

const failure = (operation: ArtifactError["operation"], reason: ArtifactError["reason"]) =>
  ArtifactError.make({ operation, reason });

const fromClient = (operation: ArtifactError["operation"]) => (error: ClientError) =>
  ArtifactError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

export interface ReplayAccess {
  readonly reference: RecordingPageReference;
  /** Temporary playback material for an authorized host route; never includes the API key. */
  readonly playlist: Redacted.Redacted<string>;
  readonly fetchedAtMillis: number;
  readonly mediaCount: number;
  /** Optional host proxy of an indexed URI from this exact playlist; no arbitrary URL parameter. */
  readonly media: (
    index: number,
    limits: DownloadLimits,
  ) => Stream.Stream<Uint8Array, ArtifactError>;
}

/** Media-playlist validation, not a player. Unsupported URI-bearing tags fail closed. */
const playlistUrls = (body: string, allowed: (url: string) => boolean): ReadonlyArray<string> => {
  const lines = body.split(/\r?\n/);

  if (lines[0] !== "#EXTM3U" || !lines.includes("#EXT-X-ENDLIST") || lines.length > 32768) {
    throw failure("replay-playlist", "malformed");
  }
  const urls: string[] = [];

  for (const raw of lines.slice(1)) {
    const line = raw.trim();

    if (line === "") continue;
    if (
      line.startsWith("#EXT-X-STREAM-INF") ||
      line.startsWith("#EXT-X-MEDIA:") ||
      (line.startsWith("#EXT-X-KEY:") && line !== "#EXT-X-KEY:METHOD=NONE")
    ) {
      throw failure("replay-playlist", "unsupported");
    }
    let url: string | undefined;

    if (!line.startsWith("#")) url = line;
    else if (/URI\s*=/.test(line)) {
      if (!line.startsWith("#EXT-X-MAP:")) throw failure("replay-playlist", "unsupported");
      const match = /(?:^|,)URI="([^"]+)"(?:,|$)/.exec(line.slice("#EXT-X-MAP:".length));

      if (match === null) throw failure("replay-playlist", "malformed");
      url = match[1];
    }
    if (url !== undefined) {
      if (!allowed(url) || urls.length >= 16384) throw failure("replay-playlist", "unsafe-url");
      urls.push(url);
    }
  }
  if (urls.length === 0) throw failure("replay-playlist", "malformed");

  return urls;
};

export class BrowserbaseReplays extends Context.Service<
  BrowserbaseReplays,
  {
    readonly metadata: (
      reference: SessionReference,
    ) => Effect.Effect<ReadonlyArray<ReplayPage>, ArtifactError>;
    readonly openPage: (
      reference: RecordingPageReference,
    ) => Effect.Effect<ReplayAccess, ArtifactError>;
  }
>()("effect-browserbase/Replays") {
  static readonly layer: Layer.Layer<
    BrowserbaseReplays,
    never,
    BrowserbaseClient | BrowserbaseSessions
  > = Layer.effect(
    BrowserbaseReplays,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;

      const metadata = Effect.fnUntraced(function* (ref: SessionReference) {
        yield* requireTerminalSession(
          sessions,
          ref,
          () => failure("replay", "active"),
          (error) => ArtifactError.make({ operation: "replay", reason: error.reason }),
        );

        const raw = yield* client
          .json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/replays`)
          .pipe(
            Effect.mapError(fromClient("replay-metadata")),
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(Metadata)(value).pipe(
                Effect.mapError(() => failure("replay-metadata", "malformed")),
              ),
            ),
          );

        if (
          raw.pageCount !== raw.pages.length ||
          new Set(raw.pages.map((page) => page.pageId)).size !== raw.pages.length ||
          raw.pages.some((page) => page.startTimeMs < 0 || page.endTimeMs < page.startTimeMs)
        ) {
          return yield* failure("replay-metadata", "malformed");
        }

        return raw.pages.map((page) =>
          ReplayPage.make({
            pageId: page.pageId,
            startTimeMs: page.startTimeMs,
            endTimeMs: page.endTimeMs,
          }),
        );
      });

      const openPage = Effect.fnUntraced(function* (ref: RecordingPageReference) {
        yield* Schema.decodeEffect(RecordingPageReference)(ref).pipe(
          Effect.mapError(() => failure("replay", "configuration")),
        );

        const pages = yield* metadata(ref.session);

        if (!pages.some((page) => page.pageId === ref.pageId))
          return yield* failure("replay", "not-found");

        const body = yield* client
          .text(
            `/v1/sessions/${encodeURIComponent(ref.session.sessionId)}/replays/${encodeURIComponent(ref.pageId)}`,
            1024 * 1024,
            ["application/vnd.apple.mpegurl", "application/x-mpegurl"],
          )
          .pipe(Effect.mapError(fromClient("replay-playlist")));

        // One sanitized rejection: an unsupported tag and an unapproved URI are both
        // refusals to interpret the playlist, and neither may echo its contents.
        const urls = yield* Effect.try({
          try: () => playlistUrls(body, client.validateMediaUrl),
          catch: () => failure("replay-playlist", "malformed"),
        });

        return {
          reference: ref,
          playlist: Redacted.make(body),
          fetchedAtMillis: yield* Clock.currentTimeMillis,
          mediaCount: urls.length,
          media: (index: number, limits: DownloadLimits) => {
            const url = Number.isSafeInteger(index) ? urls[index] : undefined;

            return url === undefined
              ? Stream.fail(failure("replay-media", "not-found"))
              : Stream.unwrap(
                  transferPolicy(
                    {
                      maxBytes: limits.maxBytes,
                      ...(limits.timeoutMillis === undefined
                        ? {}
                        : { timeoutMillis: limits.timeoutMillis }),
                    },
                    () => failure("replay-media", "configuration"),
                  ).pipe(
                    Effect.map(({ maxBytes, timeoutMillis }) =>
                      client
                        .media(
                          Redacted.make(url),
                          maxBytes,
                          ["video/mp4", "video/iso.segment", "application/octet-stream"],
                          timeoutMillis,
                        )
                        .pipe(Stream.mapError(fromClient("replay-media"))),
                    ),
                  ),
                );
          },
        } satisfies ReplayAccess;
      });

      return BrowserbaseReplays.of({ metadata, openPage });
    }),
  );
}
