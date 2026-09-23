import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { BrowserError } from "effect-browser/errors";
import * as BrowserTesting from "effect-browser/testing";
import { FetchHttpClient } from "effect/unstable/http";

import { type Services as AccountServices, layer as accountLayer } from "./Account.ts";
import { BrowserbaseBrowser, type BrowserOptions } from "./Browser.ts";
import { layer as bindingLayer } from "./BrowserBinding.ts";
import { ClientError } from "./Errors.ts";
import { type LaunchRecipe, recipe } from "./Launch.ts";
import { Identifier } from "./References.ts";
import { ProviderSession, SessionStatus } from "./SessionData.ts";

/**
 * How the scripted control plane answers. Everything else about a session is what the real
 * `Client`, `Sessions`, allocation and cleanup code makes of those answers.
 */
export const ProviderScript = Schema.Struct({
  projectId: Schema.optionalKey(Identifier),
  /**
   * The creation reply: `Accept` allocates a session (running unless told otherwise), `Reject`
   * refuses with a status the real transport classifies, `Malformed` replies without an
   * identity, and `Lost` fails the request after it was sent, so the outcome is unknown.
   */
  create: Schema.optionalKey(
    Schema.Union([
      Schema.TaggedStruct("Accept", { status: Schema.optionalKey(SessionStatus) }),
      Schema.TaggedStruct("Reject", {
        status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
        retryAfterMillis: Schema.optionalKey(Schema.Natural),
      }),
      Schema.TaggedStruct("Malformed", {}),
      Schema.TaggedStruct("Lost", {}),
    ]),
  ),
  /** What a release request does: the session ends, stays running, or the request fails. */
  release: Schema.optionalKey(Schema.Literals(["confirmed", "pending", "failed"])),
  liveView: Schema.optionalKey(Schema.Literals(["issued", "denied"])),
  region: Schema.optionalKey(ProviderSession.fields.region),
});

export type ProviderScript = typeof ProviderScript.Type;

export interface ProviderCall {
  readonly method: string;
  readonly path: string;
}

export interface ProviderSessionRecord {
  readonly id: string;
  readonly status: SessionStatus;
  readonly releaseRequests: number;
  readonly uploads: ReadonlyArray<string>;
}

export interface ProviderControl {
  readonly projectId: string;
  readonly calls: Effect.Effect<ReadonlyArray<ProviderCall>>;
  readonly sessions: Effect.Effect<ReadonlyArray<ProviderSessionRecord>>;
  /** Move a session as the provider might while it is connected, for example to `TIMED_OUT`. */
  readonly setStatus: (sessionId: string, status: SessionStatus) => Effect.Effect<void>;
  /** Marker strings the double uses where real secrets would be, to grep evidence for leaks. */
  readonly secrets: {
    readonly apiKey: string;
    readonly connectUrl: string;
    readonly liveView: string;
  };
}

/** A scripted control plane: a `FetchHttpClient.Fetch` and the handle that inspects it. */
export interface ScriptedProvider {
  readonly fetch: typeof globalThis.fetch;
  readonly control: ProviderControl;
}

const secrets = {
  apiKey: "SCRIPTED-API-KEY-NOT-A-CREDENTIAL",
  connectUrl: "SCRIPTED-CONNECT-KEY",
  liveView: "SCRIPTED-LIVE-VIEW",
} as const;

interface SessionRow {
  readonly id: string;
  status: SessionStatus;
  releaseRequests: number;
  readonly uploads: Array<string>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * The reviewed session subset of the provider API, answered in memory: creation, retrieval,
 * listing, release, Live View issuance and uploads. Provide it as `FetchHttpClient.Fetch`
 * beneath the real `BrowserbaseClient.layer`, or use `layer` below, which does that.
 */
export const provider = Effect.fnUntraced(function* (
  script: ProviderScript = {},
): Effect.fn.Return<ScriptedProvider, ClientError> {
  const fixed = yield* Schema.decodeEffect(ProviderScript)(script, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      ClientError.make({
        operation: "configure",
        reason: "configuration",
        outcome: "undispatched",
      }),
    ),
  );

  const projectId = fixed.projectId ?? "project-1";
  const region = fixed.region ?? "us-east-1";
  const calls: Array<ProviderCall> = [];
  const sessions = new Map<string, SessionRow>();
  let serial = 0;

  const row = (session: SessionRow) => ({
    id: session.id,
    projectId,
    status: session.status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    ...(session.status === "COMPLETED" ||
    session.status === "ERROR" ||
    session.status === "TIMED_OUT"
      ? { endedAt: "2026-01-01T00:10:00.000Z" }
      : {}),
    keepAlive: false,
    proxyBytes: 0,
    region,
    connectUrl: `wss://connect.browserbase.com/?session=${session.id}&key=${secrets.connectUrl}`,
  });

  const create = fixed.create ?? { _tag: "Accept" as const };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    calls.push({ method: request.method, path: url.pathname });
    if (url.origin !== "https://api.browserbase.com")
      return json({ error: "unexpected origin" }, 404);
    if (request.headers.get("x-bb-api-key") !== secrets.apiKey)
      return json({ error: "unauthorized" }, 401);
    const parts = url.pathname.split("/").filter((part) => part.length > 0);

    if (parts[0] !== "v1" || parts[1] !== "sessions") return json({}, 404);
    if (parts.length === 2) {
      if (request.method === "GET") return json([...sessions.values()].map(row));
      if (request.method !== "POST") return json({}, 404);
      switch (create._tag) {
        case "Reject":
          return json(
            { error: "rejected" },
            create.status,
            create.retryAfterMillis === undefined
              ? {}
              : { "retry-after": String(Math.max(1, Math.ceil(create.retryAfterMillis / 1000))) },
          );
        case "Malformed":
          return json({ id: 12 });
        case "Lost":
          throw new Error("The scripted provider lost this reply");
        case "Accept": {
          const session: SessionRow = {
            id: `session-${++serial}`,
            status: create.status ?? "RUNNING",
            releaseRequests: 0,
            uploads: [],
          };

          sessions.set(session.id, session);

          return json({ id: session.id, projectId });
        }
      }
    }
    const session = sessions.get(parts[2] ?? "");

    if (session === undefined) return json({ error: "not found" }, 404);
    if (parts.length === 3) {
      if (request.method === "GET") return json(row(session));
      if (request.method !== "POST") return json({}, 404);
      session.releaseRequests++;
      switch (fixed.release ?? "confirmed") {
        case "confirmed":
          session.status = "COMPLETED";

          return json(row(session));
        case "pending":
          return json(row(session));
        case "failed":
          return json({ error: "release failed" }, 500);
      }
    }
    if (parts[3] === "debug" && request.method === "GET")
      return fixed.liveView === "denied"
        ? json({ error: "denied" }, 403)
        : json({
            debuggerFullscreenUrl: `https://www.browserbase.com/devtools-fullscreen/inspector.html?scripted=${secrets.liveView}`,
            pages: [],
          });
    if (parts[3] === "uploads" && request.method === "POST") {
      const file = (await request.formData()).get("file");

      session.uploads.push(file instanceof File ? file.name : "upload");

      return json({ message: "File uploaded successfully" });
    }

    return json({}, 404);
  };

  const control: ProviderControl = {
    projectId,
    calls: Effect.sync(() => calls.map((call) => Object.freeze({ ...call }))),
    sessions: Effect.sync(() =>
      [...sessions.values()].map((session) =>
        Object.freeze({
          id: session.id,
          status: session.status,
          releaseRequests: session.releaseRequests,
          uploads: Object.freeze([...session.uploads]),
        }),
      ),
    ),
    setStatus: (sessionId, status) =>
      Effect.sync(() => {
        const session = sessions.get(sessionId);

        if (session !== undefined) session.status = status;
      }),
    secrets,
  };

  return { fetch, control };
});

/** The scripted provider and the scripted engines behind one `layer`, for a test to inspect. */
export class ScriptedBrowserbase extends Context.Service<
  ScriptedBrowserbase,
  {
    readonly provider: ProviderControl;
    /** One control for each browser connection the Layer made, in connection order. */
    readonly browsers: Effect.Effect<ReadonlyArray<BrowserTesting.ScriptedControl>>;
  }
>()("effect-browserbase/testing/ScriptedBrowserbase") {}

export interface ScriptedLayerOptions {
  readonly browser: BrowserTesting.Script;
  readonly provider?: ProviderScript;
  /** Defaults to `recipe()`: a five-minute provider lifetime and a provider-managed viewport. */
  readonly launch?: LaunchRecipe;
  readonly options?: Omit<BrowserOptions, "launch">;
}

/**
 * The real account and browser Layers over the scripted provider and the scripted engine.
 * Allocation attempts, release reconciliation, cleanup receipts, `onCleanup`,
 * `onAllocationUncertain`, borrowed attachment and every resource service run for real;
 * only the provider's replies and the browser's pages are scripted.
 */
export const layer = (
  options: ScriptedLayerOptions,
): Layer.Layer<
  BrowserbaseBrowser | AccountServices | ScriptedBrowserbase,
  BrowserError | ClientError
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const scripted = yield* provider(options.provider);
      const engine = yield* BrowserTesting.binding(options.browser);

      const account = accountLayer({
        projectId: scripted.control.projectId,
        apiKey: Redacted.make(scripted.control.secrets.apiKey),
      }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, scripted.fetch)));

      const browser = BrowserbaseBrowser.layer({
        launch: options.launch ?? recipe(),
        ...options.options,
      }).pipe(Layer.provide(account), Layer.provide(bindingLayer(engine.binding)));

      const control = Layer.succeed(
        ScriptedBrowserbase,
        ScriptedBrowserbase.of({ provider: scripted.control, browsers: engine.connections }),
      );

      return Layer.mergeAll(browser, account, control);
    }),
  );
