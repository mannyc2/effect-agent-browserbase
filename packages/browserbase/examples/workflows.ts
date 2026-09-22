import { Effect, Layer, Redacted, Stream } from "effect";
import { BrowserPolicy, ClickRequest, NavigateRequest } from "effect-browser/browser-data";
import { BrowserbaseBrowser, type BrowserOptions, type LiveView } from "effect-browserbase/browser";
import { BrowserbaseClient } from "effect-browserbase/client";
import { withWriter, type ContextWriterBackend } from "effect-browserbase/context-coordination";
import { BrowserbaseDownloads } from "effect-browserbase/downloads";
import type { LaunchRecipe } from "effect-browserbase/launch";
import { BrowserbaseRecordings } from "effect-browserbase/recordings";
import { ContextReference, type SessionReference } from "effect-browserbase/references";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import { RecordingPageReference } from "effect-browserbase/transfers";

export interface Credentials {
  readonly projectId: string;
  readonly apiKey: string;
  /** Exact trusted HTTPS origins required for provider recording downloads. */
  readonly artifactOrigins?: ReadonlyArray<string>;
}

/** One account and one resource service for every browser and artifact operation below. */
const account = (credentials: Credentials) =>
  BrowserbaseSessions.layer.pipe(
    Layer.provideMerge(
      BrowserbaseClient.layer({
        projectId: credentials.projectId,
        apiKey: Redacted.make(credentials.apiKey),
        ...(credentials.artifactOrigins === undefined
          ? {}
          : { artifactOrigins: credentials.artifactOrigins }),
      }),
    ),
  );

const launch: LaunchRecipe = {
  remoteTimeoutSeconds: 600,
  viewport: { _tag: "Fixed", width: 1280, height: 720 },
  provider: { browserSettings: { recordSession: true } },
};

const browser = (options: Partial<BrowserOptions> = {}) =>
  BrowserbaseBrowser.layer({ launch, ...options });

const policy = BrowserPolicy.make({
  // Browserbase cannot currently prove Effect Agent's ExactHosts/PublicWeb contracts.
  // This opt-out belongs to trusted host configuration, never to model input.
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

/** Ordinary trusted application use: one scope owns one browser. */
export const inspectPage = (credentials: Credentials, url: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser).open(policy);

      yield* session.bind().navigate(NavigateRequest.make({ url }));

      return yield* session.observe({ maxTextBytes: 16 * 1024, maxControls: 32 });
    }).pipe(Effect.provide(browser().pipe(Layer.provide(account(credentials))))),
  );

/** Pause automation, let a trusted host workflow use Live View, then resume atomically. */
export const cooperativeHandoff = (
  credentials: Credentials,
  url: string,
  operator: (view: LiveView) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser).open(policy);

      yield* session.bind().navigate(NavigateRequest.make({ url }));
      const handoff = yield* session.beginHandoff(120);

      yield* operator(handoff.view);

      // The boolean is an application authorization decision, not an iframe property.
      return yield* session.resume(handoff.token, true);
    }).pipe(Effect.provide(browser().pipe(Layer.provide(account(credentials))))),
  );

/**
 * Persistent writers require an application-owned exclusive lease. The backend, not this
 * example, decides how a quarantined settlement is retained before another writer is admitted.
 */
export const persistentReconnect = <LeaseE, LeaseR>(
  credentials: Credentials,
  contextId: string,
  backend: ContextWriterBackend<LeaseE, LeaseR>,
  url: string,
) => {
  const reference = ContextReference.make({
    provider: "browserbase",
    projectId: credentials.projectId,
    contextId,
  });

  return withWriter(backend, reference, (permit) =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseBrowser).open(policy);

        yield* session.bind().navigate(NavigateRequest.make({ url }));
        const detached = yield* session.detach;
        // A later controller must explicitly establish operator release before reconnecting.
        const observation = yield* session.reconnect(true);

        return { detached, observation };
      }).pipe(
        Effect.provide(
          browser({
            launch: { ...launch, keepAlive: true, context: { reference, persist: true } },
            contextWriter: permit,
          }).pipe(Layer.provide(account(credentials))),
        ),
      ),
    ),
  );
};

/** Observe a download-producing click once, then resolve provider download identity separately. */
export const downloadFile = (credentials: Credentials, url: string) => {
  const live = Layer.merge(browser(), BrowserbaseDownloads.layer).pipe(
    Layer.provide(account(credentials)),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const host = yield* BrowserbaseBrowser;
      const downloads = yield* BrowserbaseDownloads;
      const session = yield* host.open(policy);

      yield* session.bind().navigate(NavigateRequest.make({ url }));
      const before = yield* downloads.list(session.reference);

      yield* session.clickForDownload(ClickRequest.make({ selector: "#download" }));

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
  );
};

/** Provider recording retrieval has an independent lifetime after the browser scope has ended. */
export const retrieveRecording = (
  credentials: Credentials,
  reference: SessionReference,
  pageId: string,
) => {
  const live = BrowserbaseRecordings.layer.pipe(Layer.provide(account(credentials)));

  return Effect.gen(function* () {
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
  }).pipe(Effect.provide(live));
};
