import { Effect, Redacted } from "effect";
import { FrameInfo, PageInfo, Viewport, type BrowserbaseError, type CleanupResult } from "../../src/Types.ts";
import { makeHttp } from "../../src/internal/Http.ts";
import { makeProvider } from "../../src/internal/Provider.ts";
import { acquireSession, type SessionOptions } from "../../src/internal/Session.ts";
import type { CaptureSource, Driver, DriverEvents } from "../../src/internal/Driver.ts";
import type { Ticket } from "../../src/internal/Owner.ts";

export const gate = <A>() => {
  let resolve: (value: A) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<A>((yes, no) => { resolve = yes; reject = no; });
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
  readonly onClick?: (ticket: Ticket) => Promise<string>;
  readonly onObserve?: (events: DriverEvents) => Promise<void>;
  readonly onConnect?: (driver: Driver, events: DriverEvents) => Promise<Driver>;
  readonly contextLease?: SessionOptions["contextLease"];
}

/** Script only the provider/native boundary; real Effect ownership, HTTP, parsing and scopes remain. */
export const fixture = Effect.fnUntraced(function* (options: ScriptOptions = {}) {
  const calls: string[] = [];
  const reports: CleanupResult[] = [];
  const uncertain: string[] = [];
  const state = { allocations: 0, connects: 0, localCloses: 0, releases: 0, clicks: 0, text: "initial", url: "https://example.test/", observations: 0 };
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/v1/sessions") {
      state.allocations++;
      if (options.createFails) throw new Error("PRIVATE-CREATE-FAILURE");
      return Response.json(options.malformedCreate ? { id: 12 } : { id: "session-1", projectId: "project-1", connectUrl: "wss://connect.browserbase.com?key=PRIVATE-CDP" });
    }
    if (path.endsWith("/debug")) {
      if (options.liveViewFails) return Response.json({ secret: "PRIVATE-LIVE-VIEW" }, { status: 403 });
      return Response.json({ debuggerFullscreenUrl: "https://www.browserbase.com/view?token=PRIVATE-VIEW", pages: [] });
    }
    if (request.method === "POST") {
      state.releases++;
      if (options.releaseFails) return Response.json({ detail: "PRIVATE-RELEASE" }, { status: 500 });
    }
    const status = state.releases === 0 || options.releaseFails ? "RUNNING" :
      options.releasePending && request.method === "POST" ? "RUNNING" : "COMPLETED";
    return Response.json({ id: options.statusMismatch ? "other-session" : "session-1", projectId: "project-1", status,
      connectUrl: "wss://connect.browserbase.com?key=PRIVATE-CDP" });
  };
  const http = yield* makeHttp({ projectId: "project-1", apiKey: Redacted.make("PRIVATE-API-KEY") }, fetch);
  const provider = makeProvider(http, "project-1");
  const viewport = Viewport.make({ width: 640, height: 480 });
  const connector = async (_url: unknown, _signal: AbortSignal, _driverOptions: unknown, events: DriverEvents): Promise<Driver> => {
    state.connects++;
    if (options.connectFails) throw new Error("PRIVATE-CONNECT-FAILURE");
    let pageId = "page-1", frameId = "frame-1";
    const driver: Driver = {
      selected: () => ({ pageId, frameId }), selectedTargetId: async () => "target-1",
      listPages: async () => [PageInfo.make({ pageId, targetId: "target-1", title: "fixture", url: state.url, selected: true })],
      selectPage: async (id, ticket) => { ticket.check(); pageId = id; frameId = "frame-1"; events.invalidate("target-changed"); },
      newPage: async (ticket) => { ticket.dispatch(); return "page-2"; },
      closePage: async (_id, ticket) => { ticket.dispatch(); events.invalidate("target-changed"); },
      listFrames: async () => [FrameInfo.make({ frameId, parentFrameId: null, url: state.url, name: "main" })],
      selectFrame: async (id, ticket) => { ticket.check(); frameId = id; events.invalidate("target-changed"); },
      navigate: async (url, ticket) => { ticket.dispatch(); state.url = url; events.invalidate("target-changed"); return url; },
      readText: async () => state.text,
      observe: async () => {
        await options.onObserve?.(events); state.observations++;
        return { observationId: `observation-${state.observations}`, text: state.text, url: state.url,
          controls: [], textTruncated: false, controlsTruncated: false };
      },
      click: async (_target, ticket) => {
        if (options.onClick !== undefined) return options.onClick(ticket);
        ticket.dispatch(); state.clicks++; return state.url;
      },
      fill: async (_target, value, ticket) => { ticket.dispatch(); state.text = value; return state.url; },
      scroll: async (_x, _y, ticket) => { ticket.dispatch(); return state.url; },
      screenshot: async () => new Uint8Array(),
      resize: async (_viewport, ticket) => { ticket.dispatch(); events.invalidate("resized"); },
      waitFor: async () => {}, clickAndWait: async (_target, ticket) => { ticket.dispatch(); return state.url; },
      clickForDownload: async (_target, ticket) => { ticket.dispatch(); return { downloadId: "native-1", filename: "fixture.txt", state: "completed" }; },
      dismissDialogs: async () => {}, capture: () => options.captureSource ?? ({ start: async () => {}, stop: async () => {} }),
      invalidateObservation() {}, disconnect: async () => { state.localCloses++; if (options.disconnectFails) throw new Error("PRIVATE-DISCONNECT"); },
    };
    return options.onConnect === undefined ? driver : options.onConnect(driver, events);
  };
  const acquisition = acquireSession(provider, "project-1", {
    maxActions: options.maxActions ?? 20, maxElapsedMillis: options.lifetimeMillis ?? 5000, actionTimeoutMillis: options.actionMillis ?? 1000,
  }, {
    viewport, maxReturnedBytes: 65536, recordSession: false, keepAlive: options.keepAlive ?? false,
    driver: { viewport, popupPolicy: "retain", dialogPolicy: "dismiss", maxPages: 10 },
    ...(options.contextLease === undefined ? {} : { context: { id: "context-1", persist: true }, contextLease: options.contextLease }),
    onCleanup: (report) => Effect.sync(() => { reports.push(report); }),
    onAllocationUncertain: (attempt) => Effect.sync(() => { uncertain.push(attempt.attemptId); }),
  }, connector);
  return { acquisition, calls, reports, uncertain, state, provider };
});
