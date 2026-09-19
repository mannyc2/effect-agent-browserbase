import { BrowserbaseDownloads } from "@effect-agent/platform-browserbase/downloads";
import {
  BrowserbaseInteractiveHost,
  type ContextLease,
  type InteractiveOptions,
  type LiveView,
} from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserbaseRecordings } from "@effect-agent/platform-browserbase/recordings";
import {
  RecordingPageReference,
  type SessionReference,
} from "@effect-agent/platform-browserbase/types";
import { Effect, Layer, Redacted, Stream } from "effect";
import {
  BrowserClickRequest,
  BrowserNavigateRequest,
  InteractiveBrowserPolicy,
} from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

export interface Credentials {
  readonly projectId: string;
  readonly apiKey: string;
  /** Exact trusted HTTPS origins required for provider recording downloads. */
  readonly artifactOrigins?: ReadonlyArray<string>;
}

const options = (credentials: Credentials): InteractiveOptions => ({
  projectId: credentials.projectId,
  apiKey: Redacted.make(credentials.apiKey),
  ...(credentials.artifactOrigins === undefined
    ? {}
    : { artifactOrigins: credentials.artifactOrigins }),
  recordSession: true,
});

const policy = InteractiveBrowserPolicy.make({
  // Browserbase cannot currently prove Effect Agent's ExactHosts/PublicWeb contracts.
  // This opt-out belongs to trusted host configuration, never to model input.
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const transport = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));

/** Ordinary trusted application use: one scope owns one browser. */
export const inspectPage = (credentials: Credentials, url: string) =>
  transport(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

        yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));

        return yield* session.observe({ maxTextBytes: 16 * 1024, maxControls: 32 });
      }).pipe(Effect.provide(BrowserbaseInteractiveHost.layer(options(credentials)))),
    ),
  );

/** Pause automation, let a trusted host workflow use Live View, then resume atomically. */
export const cooperativeHandoff = (
  credentials: Credentials,
  url: string,
  operator: (view: LiveView) => Effect.Effect<void>,
) =>
  transport(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

        yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));
        const handoff = yield* session.beginHandoff(120);

        yield* operator(handoff.view);

        // The boolean is an application authorization decision, not an iframe property.
        return yield* session.resume(handoff.token, true);
      }).pipe(Effect.provide(BrowserbaseInteractiveHost.layer(options(credentials)))),
    ),
  );

/** Persistent writers require an application-owned exclusive lease. */
export const persistentReconnect = (
  credentials: Credentials,
  contextId: string,
  acquireExclusiveLease: (request: {
    readonly projectId: string;
    readonly contextId: string;
  }) => Effect.Effect<ContextLease>,
  url: string,
) => {
  const live = BrowserbaseInteractiveHost.layer({
    ...options(credentials),
    keepAlive: true,
    context: { id: contextId, persist: true },
    contextLease: acquireExclusiveLease,
  });

  return transport(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

        yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));
        const detached = yield* session.detach;
        // A later controller must explicitly establish operator release before reconnecting.
        const resumed = yield* session.reconnect(true);

        return { detached, observation: resumed.observation };
      }).pipe(Effect.provide(live)),
    ),
  );
};

/** Observe a download-producing click once, then resolve provider download identity separately. */
export const downloadFile = (credentials: Credentials, url: string) => {
  const common = options(credentials);

  const live = Layer.merge(
    BrowserbaseInteractiveHost.layer(common),
    BrowserbaseDownloads.layer(common),
  );

  return transport(
    Effect.scoped(
      Effect.gen(function* () {
        const host = yield* BrowserbaseInteractiveHost;
        const downloads = yield* BrowserbaseDownloads;
        const session = yield* host.open(policy);

        yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));
        const before = yield* downloads.list(session.reference);

        yield* session.clickForDownload(BrowserClickRequest.make({ selector: "#download" }));

        const fresh = yield* downloads.waitForNew(
          session.reference,
          before.downloads.map((item) => item.id),
        );

        const file = fresh[0];

        if (file === undefined) return yield* Effect.die("provider returned no new download");

        const bytes = yield* downloads
          .stream(session.reference, file.id, {
            maxBytes: 16 * 1024 * 1024,
            mimeTypes: [file.mimeType],
          })
          .pipe(Stream.runCollect);

        return { file, bytes };
      }).pipe(Effect.provide(live)),
    ),
  );
};

/** Provider recording retrieval has an independent lifetime after the browser scope has ended. */
export const retrieveRecording = (
  credentials: Credentials,
  reference: SessionReference,
  pageId: string,
) => {
  const live = BrowserbaseRecordings.layer(options(credentials));

  return transport(
    Effect.gen(function* () {
      const recordings = yield* BrowserbaseRecordings;

      yield* recordings.request(reference);
      const batch = yield* recordings.wait(reference, { timeoutMillis: 120_000 });
      const page = batch.pages.find((item) => item.pageId === pageId);

      if (page === undefined || page.delivery !== "download") return batch;

      const bytes = yield* recordings
        .download(RecordingPageReference.make({ session: reference, pageId }), {
          maxBytes: 512 * 1024 * 1024,
          timeoutMillis: 120_000,
        })
        .pipe(Stream.runCollect);

      return { batch, bytes };
    }).pipe(Effect.provide(live)),
  );
};
