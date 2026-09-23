import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  FrameInfo,
  PageInfo,
  Viewport,
  ViewportEvidence,
} from "../../../packages/browser/src/BrowserData.ts";
import { BrowserError, Reasons } from "../../../packages/browser/src/Errors.ts";
import { fromNativeAttempt } from "../../../packages/browser/src/internal/browser/Binding.ts";
import type { Bindings } from "../../../packages/browser/src/internal/browser/Bindings.ts";
import type {
  CaptureSource,
  Driver,
  DriverEvents,
  NativeNavigation,
  ReadinessState,
} from "../../../packages/browser/src/internal/browser/Driver.ts";
import type { Ticket } from "../../../packages/browser/src/internal/browser/Owner.ts";
import { acquireSession } from "../../../packages/browser/src/internal/browser/Session.ts";
import type { CleanupResult } from "../../../packages/browserbase/src/Cleanup.ts";
import { BrowserbaseClient } from "../../../packages/browserbase/src/Client.ts";
import { ownedRemote } from "../../../packages/browserbase/src/internal/session/Browser.ts";
import type { ContextWriterPermit } from "../../../packages/browserbase/src/internal/session/WriterFacts.ts";
import type { LaunchRecipe } from "../../../packages/browserbase/src/Launch.ts";
import { ContextReference } from "../../../packages/browserbase/src/References.ts";
import { BrowserbaseSessions } from "../../../packages/browserbase/src/Sessions.ts";

export const gate = <A>() => {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
};

/** Checked-shaped identities at this scripted native boundary; real registries have native tests. */
export const scriptedPage = (pageId: string) =>
  PageInfo.make({
    pageId,
    targetId: "target-1",
    title: "fixture",
    url: "https://example.test/",
    selected: pageId === "page-1",
  });

export interface ScriptOptions {
  readonly createFails?: boolean;
  readonly malformedCreate?: boolean;
  readonly connectFails?: boolean;
  readonly disconnectFails?: boolean;
  readonly captureSource?: CaptureSource;
  readonly releaseFails?: boolean;
  readonly releasePending?: boolean;
  readonly statusMismatch?: boolean;
  readonly liveViewFails?: boolean;
  readonly keepAlive?: boolean;
  readonly lifetimeMillis?: number;
  readonly actionMillis?: number;
  readonly maxActions?: number;
  readonly maxHostReads?: number;
  readonly onDisconnect?: () => void;
  readonly onClick?: (ticket: Ticket) => Promise<string>;
  /** Script a navigation that stays in flight: the test settles or stops it. */
  readonly onNavigate?: (url: string, pageId: string) => NativeNavigation;
  readonly onObserve?: (events: DriverEvents) => Promise<void>;
  readonly onConnect?: (driver: Driver, events: DriverEvents) => Promise<Driver>;
  /** Script the document-readiness state the owner must respect before dependent work. */
  readonly readiness?: () => ReadinessState;
  /** Exercise the persistent-context path through the canonical writer permit. */
  readonly contextWriter?: ContextWriterPermit;
  readonly connectBindings?: Bindings<never>["connect"];
}

const SESSION = {
  projectId: "project-1",
  createdAt: "2026-09-20T19:00:00.000Z",
  updatedAt: "2026-09-20T19:01:00.000Z",
  expiresAt: "2026-09-20T20:00:00.000Z",
  startedAt: "2026-09-20T19:00:01.000Z",
  keepAlive: false,
  proxyBytes: 0,
  region: "us-east-1" as const,
  connectUrl: "wss://connect.browserbase.com?key=PRIVATE-CDP",
};

const makeFixture = (options: ScriptOptions) => {
  const calls: string[] = [];
  const reports: CleanupResult[] = [];
  const uncertain: string[] = [];

  const state = {
    allocations: 0,
    connects: 0,
    localCloses: 0,
    releases: 0,
    clicks: 0,
    text: "initial",
    url: "https://example.test/",
    observations: 0,
    selected: [] as string[],
    readinessChecks: 0,
    /** Every native input command this scripted driver was asked to dispatch, in order. */
    input: [] as string[],
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    calls.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/v1/sessions") {
      state.allocations++;
      if (options.createFails) throw new Error("PRIVATE-CREATE-FAILURE");

      return Response.json(
        options.malformedCreate ? { id: 12 } : { id: "session-1", projectId: "project-1" },
      );
    }
    if (path.endsWith("/debug")) {
      if (options.liveViewFails)
        return Response.json({ secret: "PRIVATE-LIVE-VIEW" }, { status: 403 });

      return Response.json({
        debuggerFullscreenUrl: "https://www.browserbase.com/view?token=PRIVATE-VIEW",
        pages: [],
      });
    }
    if (request.method === "POST") {
      state.releases++;
      if (options.releaseFails)
        return Response.json({ detail: "PRIVATE-RELEASE" }, { status: 500 });
    }

    const status =
      state.releases === 0 || options.releaseFails
        ? "RUNNING"
        : options.releasePending && request.method === "POST"
          ? "RUNNING"
          : "COMPLETED";

    return Response.json({
      ...SESSION,
      id: options.statusMismatch ? "other-session" : "session-1",
      status,
      keepAlive: options.keepAlive ?? false,
    });
  };

  const viewport = Viewport.make({ width: 640, height: 480 });

  const quietViewport = ViewportEvidence.make({
    width: 640,
    height: 480,
    clippedText: 0,
    coveredText: 0,
    uncertainText: 0,
    unreachableControls: 0,
    exhausted: false,
  });

  const connector = async (
    _url: unknown,
    _signal: AbortSignal,
    _driverOptions: unknown,
    events: DriverEvents,
  ): Promise<Driver> => {
    state.connects++;
    if (options.connectFails) throw new Error("PRIVATE-CONNECT-FAILURE");

    let pageId = "page-1",
      frameId = "frame-1";

    const driver: Driver = {
      selected: () => ({ pageId, frameId }),
      selectedTargetId: async () => "target-1",
      listPages: async () => [
        PageInfo.make({
          pageId,
          targetId: "target-1",
          title: "fixture",
          url: state.url,
          selected: true,
        }),
      ],
      resolvePage: async (page, ticket) => {
        ticket.check();
        if (page.pageId !== pageId || page.targetId !== "target-1")
          throw BrowserError.make({
            operation: "target",
            reason: Reasons.NotFound.make({}),
            outcome: "undispatched",
          });

        return { pageId, frameId: "frame-1" };
      },
      selectPage: async (page, ticket) => {
        ticket.check();
        if (page.targetId !== "target-1")
          throw BrowserError.make({
            operation: "select-page",
            reason: Reasons.Stale.make({}),
            outcome: "undispatched",
          });
        pageId = page.pageId;
        frameId = "frame-1";
        events.invalidate("target-changed");
      },
      newPage: async (ticket) => {
        ticket.dispatch();

        return scriptedPage("page-2");
      },
      closePage: async (_id, ticket) => {
        ticket.dispatch();
        events.invalidate("target-changed");
      },
      listFrames: async () => [
        FrameInfo.make({ frameId, parentFrameId: null, url: state.url, name: "main" }),
      ],
      resolveFrame: async (page, frame, ticket) => {
        ticket.check();
        if (page.pageId !== pageId || page.targetId !== "target-1" || frame.frameId !== frameId)
          throw BrowserError.make({
            operation: "target",
            reason: Reasons.NotFound.make({}),
            outcome: "undispatched",
          });

        return { pageId, frameId };
      },
      selectFrame: async (id, ticket) => {
        ticket.check();
        frameId = id;
        events.invalidate("target-changed");
      },
      beginNavigation: async (url, _timeoutMillis, ticket) => {
        ticket.dispatch();
        state.url = url;
        events.invalidate("target-changed");

        return (
          options.onNavigate?.(url, pageId) ?? {
            pageId,
            settled: Promise.resolve(url),
            stop: async (stopTicket, pending, onDispatch) => {
              stopTicket.check();
              if (!pending()) return "settled" as const;
              stopTicket.dispatch();
              onDispatch();

              return "dispatched" as const;
            },
          }
        );
      },
      readText: async () => state.text,
      observe: async (scope) => {
        await options.onObserve?.(events);
        state.observations++;

        return {
          observationId: `observation-${state.observations}`,
          scope,
          text: state.text,
          url: state.url,
          controls: [],
          textTruncated: false,
          controlsTruncated: false,
          viewport: quietViewport,
        };
      },
      // Passive by construction here too: it never touches `state.observations`.
      checkpoint: async (_bytes, _controls, pictureBytes) => ({
        text: state.text,
        url: state.url,
        controls: [],
        textTruncated: false,
        controlsTruncated: false,
        viewport: quietViewport,
        documentChanged: false,
        ...(pictureBytes === undefined ? {} : { picture: new Uint8Array([137, 80, 78, 71]) }),
      }),
      controlFacts: async () => {
        throw new Error("PRIVATE-NO-RETAINED-NODE");
      },
      revalidate: async () => {
        throw new Error("PRIVATE-NO-RETAINED-NODE");
      },
      selectOption: async () => {
        throw new Error("PRIVATE-NO-RETAINED-OPTION");
      },
      click: async (_target, ticket) => {
        if (options.onClick !== undefined) return options.onClick(ticket);
        ticket.dispatch();
        state.clicks++;

        return state.url;
      },
      fill: async (_target, value, ticket) => {
        ticket.dispatch();
        state.text = value;

        return state.url;
      },
      scroll: async (_x, _y, ticket) => {
        ticket.dispatch();

        return state.url;
      },
      pointerMove: async (to, ticket) => {
        ticket.dispatch();
        state.input.push(`move ${pageId} ${to.x},${to.y}`);

        return { position: to };
      },
      hover: async (_target, ticket) => {
        ticket.dispatch();
        state.input.push(`hover ${pageId}`);

        return { position: { x: 10, y: 20 } };
      },
      wheel: async (deltaX, deltaY, at, ticket) => {
        ticket.dispatch();
        state.input.push(`wheel ${pageId} ${deltaX},${deltaY}`);

        return { position: at ?? null };
      },
      // The text itself is never recorded: a receipt, and this log, say only that keys were sent.
      press: async (key, modifiers, _into, ticket) => {
        ticket.dispatch();
        state.input.push(`press ${pageId} ${[...modifiers, key].join("+")}`);

        return { position: null };
      },
      type: async (text, _into, ticket) => {
        ticket.dispatch();
        state.input.push(`type ${pageId} ${[...text].length}`);

        return { position: null };
      },
      screenshot: async () => new Uint8Array(),
      resize: async (_viewport, ticket) => {
        ticket.dispatch();
        events.invalidate("resized");
      },
      waitFor: async (_selector, _state, ticket) => {
        ticket.retire();
      },
      waitForElement: async (_reference, _state, ticket) => {
        ticket.retire();
      },
      clickAndWait: async (_target, ticket) => {
        ticket.dispatch();

        return state.url;
      },
      clickForDownload: async (_target, ticket) => {
        ticket.dispatch();

        return { downloadId: "native-1", filename: "fixture.txt", state: "completed" };
      },
      selectFiles: async (_target, files, ticket) => {
        ticket.dispatch();
        state.selected.push(
          ...files.map((file) => (file._tag === "Inline" ? file.name : file.path)),
        );

        return state.url;
      },
      clickForFileSelection: async (_target, files, ticket) => {
        ticket.dispatch();
        state.selected.push(
          ...files.map((file) => (file._tag === "Inline" ? file.name : file.path)),
        );

        return state.url;
      },
      documentReadiness: async (ticket) => {
        ticket.check();
        state.readinessChecks++;

        return options.readiness?.() ?? { _tag: "Ready" as const };
      },
      dismissDialogs: async () => {},
      capture: async (target) => ({
        pageId: target?.pageId ?? pageId,
        targetId: target?.targetId ?? "target-1",
        frameId,
        source: options.captureSource ?? { start: async () => {}, stop: async () => {} },
      }),
      invalidateObservation() {},
      disconnect: async () => {
        state.localCloses++;
        options.onDisconnect?.();
        if (options.disconnectFails) throw new Error("PRIVATE-DISCONNECT");
      },
    };

    return options.onConnect === undefined ? driver : options.onConnect(driver, events);
  };

  const lifetimeMillis = options.lifetimeMillis ?? 5000;

  const launch: LaunchRecipe = {
    remoteTimeoutSeconds: Math.min(21600, Math.max(60, Math.ceil(lifetimeMillis / 1000))),
    keepAlive: options.keepAlive ?? false,
    viewport: { _tag: "Fixed", width: viewport.width, height: viewport.height },
    provider: {},
    ...(options.contextWriter === undefined
      ? {}
      : {
          context: {
            reference: ContextReference.make({
              provider: "browserbase",
              projectId: "project-1",
              contextId: "context-1",
            }),
            persist: true,
          },
        }),
  };

  const acquisition = acquireSession(
    {
      maxActions: options.maxActions ?? 20,
      maxHostReads: options.maxHostReads ?? 10_000,
      maxElapsedMillis: lifetimeMillis,
      actionTimeoutMillis: options.actionMillis ?? 1000,
    },
    {
      implementation: "browserbase-playwright-cdp",
      engine: fromNativeAttempt((request, signal) =>
        connector(request.connection, signal, request.options, request.events),
      ),
      remote: ownedRemote({
        launch,
        ...(options.contextWriter === undefined ? {} : { contextWriter: options.contextWriter }),
        onCleanup: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        onAllocationUncertain: (attempt) =>
          Effect.sync(() => {
            uncertain.push(attempt.attemptId);
          }),
      }),
      keepAlive: options.keepAlive ?? false,
      maxReturnedBytes: 65536,
      driver: { viewport, popupPolicy: "retain", dialogPolicy: "dismiss", maxPages: 10 },
      ...(options.connectBindings === undefined
        ? {}
        : { connectBindings: options.connectBindings }),
    },
  ).pipe(
    Effect.provide(NodeCrypto.layer),
    Effect.flatMap((acquired) =>
      Effect.gen(function* () {
        const connected = yield* Effect.cached(
          acquired.connect.pipe(
            Effect.map((controls) => ({
              ...controls,
              liveView: (ttl: number) => controls.liveView(acquired.lease.liveView(ttl)),
              beginHandoff: (ttl: number) => controls.beginHandoff(acquired.lease.liveView(ttl)),
            })),
          ),
        );

        return {
          ...acquired,
          rawConnect: acquired.connect,
          connect: acquired.connect.pipe(Effect.andThen(connected)),
        };
      }),
    ),
    Effect.provide(
      BrowserbaseSessions.layer.pipe(
        Layer.provideMerge(
          BrowserbaseClient.layer({
            projectId: "project-1",
            apiKey: Redacted.make("PRIVATE-API-KEY"),
          }),
        ),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

  return { acquisition, calls, reports, uncertain, state, fetch };
};

/** Script only the provider/native boundary; real Effect ownership, HTTP, parsing and scopes remain. */
export const fixture = (options: ScriptOptions = {}) => Effect.sync(() => makeFixture(options));
