import { NodeCrypto } from "@effect/platform-node";
import { Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError } from "effect-browser/errors";
import * as Account from "effect-browserbase/account";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { CleanupResult } from "effect-browserbase/cleanup";
import { BrowserbaseClient } from "effect-browserbase/client";
import type { ClientError } from "effect-browserbase/errors";
import { recipe } from "effect-browserbase/launch";
import type { AllocationAttempt } from "effect-browserbase/references";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import { FetchHttpClient } from "effect/unstable/http";

import type { localAgentBrowser } from "../fixtures/AgentBrowser.ts";
import { type Journal, json, tagOf, type Recording } from "./Records.ts";

export const released = (journal: Journal) => (result: CleanupResult) =>
  Effect.sync(() => {
    journal.cleanup =
      result.remote === "confirmed" && result.local === "closed" && result.issues.length === 0
        ? "confirmed"
        : "unconfirmed";
    journal.cleanupReceipt = json({
      remote: result.remote,
      local: result.local,
      releaseRequested: result.releaseRequested,
      issues: result.issues.map(({ step, reason }) => ({ step, reason })),
    });
  });

export const liveBrowserbase = (
  journal: Journal,
  projectId: Redacted.Redacted<string>,
  apiKey: Redacted.Redacted<string>,
) =>
  BrowserbaseBrowser.layer({
    launch: recipe({
      remoteTimeoutSeconds: Math.ceil((journal.manifest.capture.maxDurationMillis + 60000) / 1000),
      viewport: { _tag: "Fixed", ...journal.manifest.viewport },
    }),
    actionTimeoutMillis: 15000,
    pageControl: true,
    onCleanup: released(journal),
    onAllocationUncertain: () =>
      Effect.sync(() => {
        journal.cleanup = "unconfirmed";
        journal.cleanupReceipt = { allocation: "unknown" };
      }),
  }).pipe(
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Account.layer({
        projectId: Redacted.value(projectId),
        apiKey,
        requestTimeoutMillis: 15000,
      }),
    ),
  );

export const chromium = (journal: Journal) =>
  Chromium.layer({
    viewport: journal.manifest.viewport,
    actionTimeoutMillis: 15000,
    pageControl: true,
    launch: {
      ...(process.env.BROWSERBASE_CHROMIUM === undefined
        ? {}
        : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
      chromiumSandbox: false,
      startupTimeoutMillis: 25000,
    },
    onCleanup: (receipt) =>
      Effect.sync(() => {
        journal.cleanup =
          receipt.connection === "closed" &&
          receipt.process === "terminated" &&
          receipt.issues.length === 0
            ? "confirmed"
            : "unconfirmed";
        journal.cleanupReceipt = json({
          connection: receipt.connection,
          process: receipt.process,
          issues: receipt.issues.map(({ step, reason }) => ({ step, reason })),
        });
      }),
  }).pipe(Layer.provide(NodeCrypto.layer));

/** The original owner's checked close owns cleanup, including failed callbacks. */
export const run = <A, E, R>(
  journal: Journal,
  use: (browser: Browser.BrowserSession<never>) => Effect.Effect<A, E, R>,
  credentials?: {
    readonly projectId: Redacted.Redacted<string>;
    readonly apiKey: Redacted.Redacted<string>;
  },
  hosting?: BrowserbaseBackend,
) => {
  const policy = BrowserPolicy.unrestricted({
    maxActions: 10000,
    maxElapsedMillis: journal.manifest.capture.maxDurationMillis + 60000,
  });

  const complete = (browser: Browser.BrowserSession<never>) =>
    use(browser).pipe(
      Effect.onExit(() =>
        browser.closeChecked.pipe(
          Effect.exit,
          Effect.map((exit) => {
            journal.ownerClose = Exit.isSuccess(exit) ? "confirmed" : "failed";
          }),
        ),
      ),
    );

  const recordFailure = <F, T>(effect: Effect.Effect<A, F, T>) =>
    effect.pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          journal.failure = tagOf(cause);
        }),
      ),
    );

  const hosted =
    hosting?.layer({
      onCleanup: released(journal),
      onAllocationUncertain: () =>
        Effect.sync(() => {
          journal.cleanup = "unconfirmed";
        }),
      actionTimeoutMillis: 15000,
      remoteTimeoutSeconds: Math.ceil((journal.manifest.capture.maxDurationMillis + 60000) / 1000),
      viewport: journal.manifest.viewport,
    }) ??
    (credentials === undefined
      ? undefined
      : liveBrowserbase(journal, credentials.projectId, credentials.apiKey));

  return hosted === undefined
    ? recordFailure(
        Browser.scoped(Chromium.launch(policy), complete).pipe(Effect.provide(chromium(journal))),
      )
    : recordFailure(
        Browser.scoped(BrowserbaseBrowser.open(policy), complete).pipe(Effect.provide(hosted)),
      );
};

/** Capture the exact on-air Page while another Page can work independently. */
export const filming = Effect.fnUntraced(function* <A, E, R>(
  journal: Journal,
  page: Browser.Page,
  effect: Effect.Effect<A, E, R>,
) {
  const profile = journal.manifest.capture;

  const recording: Recording = {
    ...profile,
    frames: [],
    startedAt: journal.elapsedMillis(),
    endedAt: journal.elapsedMillis(),
    nativeStop: "missing",
    summary: null,
    totalBytes: 0,
    discardedFrames: 0,
    limitReached: null,
    error: null,
  };

  journal.recording = recording;

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const interval = yield* Capture.start(page, {
        lifetime: "page",
        maxFrames: 32,
        maxBufferedBytes: 8 * 1024 * 1024,
        maxFrameBytes: 2 * 1024 * 1024,
        maxDurationMillis: profile.maxDurationMillis,
        quality: profile.quality,
        size: journal.manifest.viewport,
      });

      const reader = yield* interval.frames.pipe(
        Stream.runForEach((frame) =>
          Effect.suspend(() => {
            if (recording.limitReached !== null) {
              recording.discardedFrames++;

              return Effect.void;
            }
            if (recording.totalBytes + frame.bytes.byteLength > profile.maxBytes) {
              recording.limitReached = "bytes";
              recording.discardedFrames++;

              return interval.stop.pipe(Effect.asVoid);
            }
            recording.frames.push({
              ...frame,
              receivedAt: journal.elapsedMillis(),
              receivedMonotonicNanos: String(frame.receivedMonotonicNanos),
            });
            recording.totalBytes += frame.bytes.byteLength;
            if (recording.frames.length >= profile.maxFrames) {
              recording.limitReached = "frames";

              return interval.stop.pipe(Effect.asVoid);
            }

            return Effect.void;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            recording.error = tagOf(cause);
          }),
        ),
        Effect.forkScoped,
      );

      return yield* effect.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* interval.stop;
            yield* Fiber.await(reader);
            const summary = yield* interval.completed;
            const { error, ...facts } = summary;

            recording.endedAt = journal.elapsedMillis();
            recording.nativeStop = summary.nativeStop;
            if (error !== undefined) recording.error ??= error._tag;
            recording.summary = json({
              ...facts,
              target: { ...summary.target },
              documentBoundaries: summary.documentBoundaries.map((boundary) => ({
                ...boundary,
                observedMonotonicNanos: String(boundary.observedMonotonicNanos),
              })),
              error:
                error === undefined
                  ? null
                  : {
                      operation: error.operation,
                      reason: error.reason._tag,
                      outcome: error.outcome,
                    },
            });
          }),
        ),
      );
    }),
  );
});

/** Public provider layer boundary used by live and local-provider bench runs. */
export interface BrowserbaseBackend {
  readonly origin: string | undefined;
  readonly layer: (options: {
    readonly onCleanup: (result: CleanupResult) => Effect.Effect<void>;
    readonly onAllocationUncertain: (attempt: AllocationAttempt) => Effect.Effect<void>;
    readonly actionTimeoutMillis: number;
    readonly remoteTimeoutSeconds: number;
    readonly viewport: { readonly width: number; readonly height: number };
  }) => Layer.Layer<BrowserbaseBrowser, BrowserError | ClientError>;
}

/** A scripted control plane over a real local Chromium; no hosted allocation. */
export const localBrowserbase = (
  fixture: Effect.Success<typeof localAgentBrowser>,
): BrowserbaseBackend => ({
  origin: undefined,
  // This fixture's own account and client, built with its local fetch, so no request leaves
  // the host and nothing is shared with another fixture.
  layer: ({
    onCleanup,
    onAllocationUncertain,
    actionTimeoutMillis,
    remoteTimeoutSeconds,
    viewport,
  }) =>
    BrowserbaseBrowser.layer({
      launch: {
        ...recipe({}),
        remoteTimeoutSeconds,
        viewport: { _tag: "Fixed", width: viewport.width, height: viewport.height },
      },
      actionTimeoutMillis,
      onCleanup,
      onAllocationUncertain,
    }).pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provide(
        BrowserbaseSessions.layer.pipe(
          Layer.provideMerge(
            BrowserbaseClient.layer({
              projectId: "project-1",
              apiKey: Redacted.make("fixture-key-not-a-credential"),
              requestTimeoutMillis: 30000,
            }),
          ),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fixture.fetch)),
        ),
      ),
      Layer.provide(fixture.binding),
    ),
});
