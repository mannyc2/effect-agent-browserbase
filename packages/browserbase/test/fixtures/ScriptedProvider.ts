import { Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { FrameInfo, PageInfo, Viewport } from "../../src/BrowserData.ts";
import type { CleanupResult } from "../../src/Cleanup.ts";
import { BrowserbaseClient } from "../../src/Client.ts";
import type { CaptureSource, Driver, DriverEvents } from "../../src/internal/browser/Driver.ts";
import type { Ticket } from "../../src/internal/browser/Owner.ts";
import { acquireSession } from "../../src/internal/browser/Session.ts";
import type { ContextWriterPermit } from "../../src/internal/session/WriterFacts.ts";
import type { LaunchRecipe } from "../../src/Launch.ts";
import { ContextReference } from "../../src/References.ts";
import { BrowserbaseSessions } from "../../src/Sessions.ts";

export const gate = <A>() => {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
};

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
  readonly onDisconnect?: () => void;
  readonly onClick?: (ticket: Ticket) => Promise<string>;
  readonly onObserve?: (events: DriverEvents) => Promise<void>;
  readonly onConnect?: (driver: Driver, events: DriverEvents) => Promise<Driver>;
  /** Exercise the persistent-context path through the canonical writer permit. */
  readonly contextWriter?: ContextWriterPermit;
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

/** Script only the provider/native boundary; real Effect ownership, HTTP, parsing and scopes remain. */
export const fixture = Effect.fnUntraced(function* (options: ScriptOptions = {}) {
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
      selectPage: async (id, ticket) => {
        ticket.check();
        pageId = id;
        frameId = "frame-1";
        events.invalidate("target-changed");
      },
      newPage: async (ticket) => {
        ticket.dispatch();

        return "page-2";
      },
      closePage: async (_id, ticket) => {
        ticket.dispatch();
        events.invalidate("target-changed");
      },
      listFrames: async () => [
        FrameInfo.make({ frameId, parentFrameId: null, url: state.url, name: "main" }),
      ],
      selectFrame: async (id, ticket) => {
        ticket.check();
        frameId = id;
        events.invalidate("target-changed");
      },
      navigate: async (url, ticket) => {
        ticket.dispatch();
        state.url = url;
        events.invalidate("target-changed");

        return url;
      },
      readText: async () => state.text,
      observe: async () => {
        await options.onObserve?.(events);
        state.observations++;

        return {
          observationId: `observation-${state.observations}`,
          text: state.text,
          url: state.url,
          controls: [],
          textTruncated: false,
          controlsTruncated: false,
        };
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
      screenshot: async () => new Uint8Array(),
      resize: async (_viewport, ticket) => {
        ticket.dispatch();
        events.invalidate("resized");
      },
      waitFor: async () => {},
      clickAndWait: async (_target, ticket) => {
        ticket.dispatch();

        return state.url;
      },
      clickForDownload: async (_target, ticket) => {
        ticket.dispatch();

        return { downloadId: "native-1", filename: "fixture.txt", state: "completed" };
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
      maxElapsedMillis: lifetimeMillis,
      actionTimeoutMillis: options.actionMillis ?? 1000,
    },
    {
      launch,
      maxReturnedBytes: 65536,
      driver: { viewport, popupPolicy: "retain", dialogPolicy: "dismiss", maxPages: 10 },
      ...(options.contextWriter === undefined ? {} : { contextWriter: options.contextWriter }),
      onCleanup: (report) =>
        Effect.sync(() => {
          reports.push(report);
        }),
      onAllocationUncertain: (attempt) =>
        Effect.sync(() => {
          uncertain.push(attempt.attemptId);
        }),
    },
    connector,
  ).pipe(
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
});
