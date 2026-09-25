import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import {
  assessAllowance,
  observeAgentRun,
  observePageFetch,
  observeSearch,
  ProviderPeriodConsumption,
  ProjectUsageObservation,
  sampleProjectUsage,
  type LocalOperationObservation,
} from "../examples/usage-observation.ts";
import { BrowserbaseAgents } from "../src/Agents.ts";
import { BrowserbaseCertificates } from "../src/Certificates.ts";
import { BrowserbaseClient } from "../src/Client.ts";
import { BrowserbaseDownloads } from "../src/Downloads.ts";
import { BrowserbaseFunctions } from "../src/Functions.ts";
import { LaunchRecipe, recipe } from "../src/Launch.ts";
import { BrowserbasePageFetch } from "../src/PageFetch.ts";
import { BrowserbaseProjects } from "../src/Projects.ts";
import { ContextReference, SessionReference } from "../src/References.ts";
import { BrowserbaseSearch } from "../src/Search.ts";
import { BrowserbaseSessions } from "../src/Sessions.ts";
import { BrowserbaseWebhooks } from "../src/Webhooks.ts";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const account = { projectId: "project-1", apiKey: Redacted.make("test-account-key") };

const session = SessionReference.make({
  provider: "browserbase",
  projectId: "project-1",
  sessionId: "session-1",
});

const stamp = "2026-09-21T00:00:00.000Z";

const services = Layer.mergeAll(
  BrowserbaseSessions.layer,
  BrowserbaseDownloads.layer.pipe(Layer.provide(BrowserbaseSessions.layer)),
  BrowserbaseProjects.layer,
  BrowserbaseCertificates.layer,
  BrowserbaseSearch.layer,
  BrowserbasePageFetch.layer,
  BrowserbaseWebhooks.layer,
  BrowserbaseAgents.layer,
  BrowserbaseFunctions.layer,
).pipe(Layer.provideMerge(BrowserbaseClient.layer(account)));

/** A scripted provider: records every request and answers from `reply`. */
const provider = (reply: (seen: Seen) => Response | Promise<Response>) => {
  const seen: Array<Seen> = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const type = request.headers.get("content-type") ?? "";

    const body = type.startsWith("application/json")
      ? await request.json()
      : type.startsWith("multipart/form-data")
        ? Object.fromEntries(
            [...(await request.formData()).entries()].map(([key, value]) => [
              key,
              typeof value === "string" ? value : value.name,
            ]),
          )
        : undefined;

    const entry = { method: request.method, path: `${url.pathname}${url.search}`, body };

    seen.push(entry);

    return reply(entry);
  };

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | BrowserbaseClient
      | BrowserbaseSessions
      | BrowserbaseDownloads
      | BrowserbaseProjects
      | BrowserbaseCertificates
      | BrowserbaseSearch
      | BrowserbasePageFetch
      | BrowserbaseWebhooks
      | BrowserbaseAgents
      | BrowserbaseFunctions
    >,
  ) => effect.pipe(Effect.provide(services), Effect.provideService(FetchHttpClient.Fetch, fetch));

  return { seen, run };
};

const failure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      assert.ok(Exit.isFailure(exit), "expected a typed failure");
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");

      assert.ok(error !== undefined && error._tag === "Fail", "expected a Fail reason");

      return error.error;
    }),
  );

it.effect("an invalid API path is a typed undispatched failure, not a defect", () => {
  const { seen, run } = provider(() => Response.json({}));

  return run(
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const error = yield* failure(client.json("GET", "/v2/escape"));

      assert.deepEqual(
        { tag: error._tag, reason: error.reason, outcome: error.outcome },
        { tag: "ClientError", reason: "configuration", outcome: "undispatched" },
      );
      assert.equal(seen.length, 0);
    }),
  );
});

it.effect("the raw client sends PATCH and PUT and never retries them", () => {
  const { seen, run } = provider(() => new Response("{}", { status: 503 }));

  return run(
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const patch = yield* failure(client.json("PATCH", "/v1/webhooks/w-1", { endpoint: "x" }));
      const put = yield* failure(client.json("PUT", "/v1/contexts/c-1"));

      assert.equal(patch.outcome, "unknown");
      assert.equal(put.outcome, "unknown");
      assert.deepEqual(
        seen.map(({ method }) => method),
        ["PATCH", "PUT"],
      );
    }),
  );
});

it.effect("layerConfig reads account authority from the ConfigProvider", () =>
  Effect.gen(function* () {
    const client = yield* BrowserbaseClient;

    assert.equal(client.projectId, "project-env");
  }).pipe(
    Effect.provide(BrowserbaseClient.layerConfig()),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({
        BROWSERBASE_PROJECT_ID: "project-env",
        BROWSERBASE_API_KEY: "env-key",
      }),
    ),
  ),
);

it.effect("layerConfig fails with a ConfigError when a variable is missing", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.provide(BrowserbaseClient, BrowserbaseClient.layerConfig()).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ BROWSERBASE_PROJECT_ID: "project-env" }),
        ),
      ),
    );

    assert.ok(Exit.isFailure(exit));
  }),
);

it("defaults describe a valid recipe and bounded policy", () => {
  const launch = recipe();

  assert.ok(Schema.is(LaunchRecipe)(launch));
  assert.deepEqual(launch.viewport, { _tag: "ProviderManaged" });
  assert.equal(launch.remoteTimeoutSeconds, 300);
  assert.equal(recipe({ remoteTimeoutSeconds: 900 }).remoteTimeoutSeconds, 900);

  const policy = BrowserPolicy.unrestricted({ maxActions: 7 });

  assert.equal(policy.maxActions, 7);
  assert.equal(policy.maxElapsedMillis, 300_000);
  assert.deepEqual(policy.network, { _tag: "Unrestricted" });
  assert.throws(() => BrowserPolicy.unrestricted({ maxActions: 0 }));
});

it.effect("session logs omit CDP payloads unless asked, and refuse foreign rows", () => {
  let foreign = false;

  const { run } = provider(() =>
    Response.json([
      {
        method: "Page.navigate",
        pageId: 0,
        sessionId: foreign ? "session-2" : "session-1",
        timestamp: 1,
        request: { params: { url: "https://a.example" }, rawBody: "{}", timestamp: 2 },
        response: { result: { frameId: "f" }, rawBody: "{}", timestamp: 3 },
      },
    ]),
  );

  return run(
    Effect.gen(function* () {
      const sessions = yield* BrowserbaseSessions;
      const [plain] = yield* sessions.logs(session);

      assert.equal(plain?.method, "Page.navigate");
      assert.equal(plain?.requestTimestamp, 2);
      assert.equal(plain?.params, undefined);
      assert.equal(plain?.result, undefined);

      const [full] = yield* sessions.logs(session, { includePayloads: true });

      assert.deepEqual(full?.params, { url: "https://a.example" });
      assert.deepEqual(full?.result, { frameId: "f" });

      foreign = true;
      assert.equal((yield* failure(sessions.logs(session))).reason, "malformed");
    }),
  );
});

it.effect("live URLs are issued for any project session and stay redacted", () => {
  const { seen, run } = provider(() =>
    Response.json({
      debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/x",
      debuggerUrl: "https://www.browserbase.com/devtools/x",
      wsUrl: "wss://connect.browserbase.com/debug/x",
      pages: [
        {
          id: "page-1",
          debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/p",
        },
      ],
    }),
  );

  return run(
    Effect.gen(function* () {
      const sessions = yield* BrowserbaseSessions;
      const view = yield* sessions.liveUrls(session, 120);

      assert.ok(Redacted.isRedacted(view.session));
      assert.equal(view.pages[0]?.liveViewPageId, "page-1");
      assert.equal(seen[0]?.path, "/v1/sessions/session-1/debug?expiresIn=120");

      const rejected = yield* failure(sessions.liveUrls(session, 0));

      assert.deepEqual([rejected.reason, rejected.outcome], ["configuration", "undispatched"]);
      assert.equal(seen.length, 1);
    }),
  );
});

it.effect("downloads filter at the provider and delete only a file the session owns", () => {
  let owner = "session-1";

  const { seen, run } = provider(({ method, path }) => {
    if (path.startsWith("/v1/sessions/"))
      return Response.json({
        id: "session-1",
        projectId: "project-1",
        status: "RUNNING",
        createdAt: stamp,
        updatedAt: stamp,
        expiresAt: stamp,
        startedAt: stamp,
        keepAlive: false,
        proxyBytes: 0,
        region: "us-west-2",
      });
    if (path.startsWith("/v1/downloads?")) return Response.json({ downloads: [], total: 0 });
    if (method === "DELETE") return new Response(null, { status: 204 });

    return Response.json({
      id: "file-1",
      sessionId: owner,
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 10,
      checksum: "a".repeat(64),
      createdAt: stamp,
    });
  });

  return run(
    Effect.gen(function* () {
      const downloads = yield* BrowserbaseDownloads;

      yield* downloads.list(session, { mimeType: "application/pdf", minSize: 1, offset: 100 });

      const query = new URLSearchParams(seen[1]!.path.split("?")[1]);

      assert.equal(query.get("mimeType"), "application/pdf");
      assert.equal(query.get("minSize"), "1");
      assert.equal(query.get("offset"), "100");
      assert.equal(query.get("sessionId"), "session-1");

      assert.equal(
        (yield* failure(downloads.list(session, { unknown: 1 } as never))).reason,
        "configuration",
      );

      yield* downloads.delete(session, "file-1");
      assert.deepEqual(seen.at(-1), {
        method: "DELETE",
        path: "/v1/downloads/file-1",
        body: undefined,
      });

      owner = "session-2";
      const before = seen.length;
      const refused = yield* failure(downloads.delete(session, "file-1"));

      assert.equal(refused.outcome, "undispatched");
      assert.ok(seen.slice(before).every(({ method }) => method !== "DELETE"));
    }),
  );
});

it.effect("projects read only the Client's project and verify its identity", () => {
  let id = "project-1";

  const project = () => ({
    id,
    name: "Main",
    ownerId: "owner-1",
    defaultTimeout: 300,
    concurrency: 25,
    createdAt: stamp,
    updatedAt: stamp,
  });

  const { seen, run } = provider(({ path }) =>
    path === "/v1/projects"
      ? Response.json([project(), { ...project(), id: "project-2" }])
      : path.endsWith("/usage")
        ? Response.json({ browserMinutes: 42, proxyBytes: 7 })
        : Response.json(project()),
  );

  return run(
    Effect.gen(function* () {
      const projects = yield* BrowserbaseProjects;

      assert.equal((yield* projects.list).length, 2);
      assert.equal((yield* projects.retrieve).concurrency, 25);
      assert.deepEqual(
        { ...(yield* projects.usage) },
        { projectId: "project-1", browserMinutes: 42, proxyBytes: 7 },
      );
      assert.deepEqual(
        seen.map(({ path }) => path),
        ["/v1/projects", "/v1/projects/project-1", "/v1/projects/project-1/usage"],
      );

      id = "project-2";
      assert.equal((yield* failure(projects.retrieve)).reason, "malformed");
    }),
  );
});

it.effect("certificates register one bounded multipart file and check project identity", () => {
  let projectId = "project-1";

  const certificate = () => ({ id: "cert-1", projectId, createdAt: stamp, updatedAt: stamp });

  const { seen, run } = provider(({ method, path }) =>
    method === "DELETE"
      ? new Response(null, { status: 204 })
      : path === "/v1/certificates" && method === "GET"
        ? Response.json([certificate()])
        : Response.json(certificate()),
  );

  return run(
    Effect.gen(function* () {
      const certificates = yield* BrowserbaseCertificates;
      const pem = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\nAA==\n");
      const created = yield* certificates.create({ bytes: pem, filename: "corp-ca.pem" });

      assert.equal(created.certificateId, "cert-1");
      assert.deepEqual(seen[0], {
        method: "POST",
        path: "/v1/certificates",
        body: { file: "corp-ca.pem" },
      });

      const limited = yield* failure(certificates.create({ bytes: pem, maxBytes: 4 }));

      assert.deepEqual([limited.reason, limited.outcome], ["limit", "undispatched"]);
      assert.equal((yield* certificates.list).length, 1);
      yield* certificates.delete("cert-1");
      assert.equal(seen.at(-1)?.method, "DELETE");

      projectId = "project-2";
      const foreign = yield* failure(certificates.create({ bytes: pem }));

      assert.deepEqual([foreign.reason, foreign.outcome], ["malformed", "unknown"]);
    }),
  );
});

it.effect("search and page fetch validate input before any HTTP request", () => {
  const { seen, run } = provider(({ path }) =>
    path === "/v1/search"
      ? Response.json({
          requestId: "r-1",
          query: "effect",
          results: [{ id: "1", url: "https://effect.website", title: "Effect" }],
        })
      : Response.json({
          id: "f-1",
          statusCode: 200,
          headers: { "content-type": "text/markdown" },
          content: "# Effect",
          contentType: "text/markdown",
          encoding: "utf-8",
        }),
  );

  return run(
    Effect.gen(function* () {
      const search = yield* BrowserbaseSearch;
      const fetch = yield* BrowserbasePageFetch;
      const found = yield* search.web({ query: "effect", numResults: 3 });

      assert.equal(found.results[0]?.title, "Effect");
      assert.deepEqual(seen[0]?.body, { query: "effect", numResults: 3 });

      const tooMany = yield* failure(search.web({ query: "effect", numResults: 26 }));

      assert.deepEqual(
        [tooMany._tag, tooMany.service, tooMany.reason],
        ["PlatformError", "search", "configuration"],
      );

      const page = yield* fetch.fetch({ url: "https://effect.website", format: "markdown" });

      assert.equal(page.content, "# Effect");

      const schemaWithoutJson = yield* failure(
        fetch.fetch({ url: "https://effect.website", schema: { type: "object" } }),
      );

      assert.equal(schemaWithoutJson.reason, "configuration");
      assert.equal(
        (yield* failure(fetch.fetch({ url: "file:///etc/passwd" }))).reason,
        "configuration",
      );
      assert.equal(seen.length, 2);
    }),
  );
});

it.effect("webhooks redact secrets, PATCH updates and refuse insecure endpoints", () => {
  const webhook = {
    id: "hook-1",
    projectId: "project-1",
    endpoint: "https://hooks.example/bb",
    eventTypes: ["functions.invocations.completed"],
    createdAt: stamp,
    updatedAt: stamp,
  };

  const { seen, run } = provider(({ method, path }) =>
    method === "DELETE"
      ? new Response(null, { status: 204 })
      : path.endsWith("/secret")
        ? Response.json({ secret: "whsec_rotated" })
        : method === "POST"
          ? Response.json({ ...webhook, secret: "whsec_initial" }, { status: 201 })
          : path.startsWith("/v1/webhooks?")
            ? Response.json({ data: [webhook], limit: 1, nextCursor: "c-2" })
            : Response.json(webhook),
  );

  return run(
    Effect.gen(function* () {
      const webhooks = yield* BrowserbaseWebhooks;

      const created = yield* webhooks.create({
        endpoint: "https://hooks.example/bb",
        eventTypes: ["functions.invocations.completed"],
      });

      assert.ok(Redacted.isRedacted(created.secret));
      assert.equal(Redacted.value(created.secret), "whsec_initial");
      assert.equal(created.webhook.webhookId, "hook-1");

      const page = yield* webhooks.list({ limit: 1 });

      assert.equal(page.nextCursor, "c-2");
      assert.equal(seen.at(-1)?.path, "/v1/webhooks?limit=1");

      yield* webhooks.update("hook-1", { eventTypes: ["functions.builds.failed"] });
      assert.deepEqual(seen.at(-1), {
        method: "PATCH",
        path: "/v1/webhooks/hook-1",
        body: { eventTypes: ["functions.builds.failed"] },
      });

      const rotated = yield* webhooks.rotateSecret("hook-1", { revokeImmediately: true });

      assert.equal(Redacted.value(rotated), "whsec_rotated");

      const before = seen.length;

      assert.equal((yield* failure(webhooks.update("hook-1", {}))).reason, "configuration");
      assert.equal(
        (yield* failure(
          webhooks.create({
            endpoint: "http://hooks.example",
            eventTypes: ["functions.builds.failed"],
          }),
        )).reason,
        "configuration",
      );
      assert.equal(seen.length, before);
    }),
  );
});

it.effect("a cooperative journal settlement timeout leaves the API reply intact", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();

    const { seen, run } = provider(() =>
      Response.json({ requestId: "r-1", query: "effect", results: [] }),
    );

    const journal = {
      begin: () => Effect.succeed("intent-1"),
      finish: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    };

    const reading = yield* run(observeSearch({ query: "effect" }, journal)).pipe(Effect.forkChild);

    yield* Deferred.await(entered);
    yield* TestClock.adjust(2_001);

    assert.equal((yield* Fiber.join(reading)).requestId, "r-1");
    assert.equal(seen.length, 1);
  }),
);

it.live("agent runs map context and proxy secrets, never retry, and wait to terminal", () => {
  let polls = 0;
  let failStart = false;

  const run_ = (status: string) => ({
    runId: "run-1",
    task: "Find the price",
    status,
    createdAt: stamp,
    updatedAt: stamp,
  });

  const { seen, run } = provider(({ method, path }) => {
    if (method === "POST" && path === "/v1/agents/runs")
      return failStart
        ? new Response("{}", { status: 502 })
        : Response.json(run_("PENDING"), { status: 201 });
    if (path.endsWith("/stop")) return Response.json(run_("STOPPED"), { status: 202 });
    polls++;

    return Response.json(run_(polls < 2 ? "RUNNING" : "COMPLETED"));
  });

  return run(
    Effect.gen(function* () {
      const agents = yield* BrowserbaseAgents;

      const reference = ContextReference.make({
        provider: "browserbase",
        projectId: "project-1",
        contextId: "context-1",
      });

      yield* agents.run({
        task: "Find the price",
        browserSettings: {
          context: { reference, persist: false },
          proxies: [
            {
              type: "external",
              server: "http://proxy.example:8080",
              password: Redacted.make("proxy-secret"),
            },
          ],
        },
      });

      assert.deepEqual(seen[0]?.body, {
        task: "Find the price",
        browserSettings: {
          context: { id: "context-1", persist: false },
          proxies: [
            { type: "external", server: "http://proxy.example:8080", password: "proxy-secret" },
          ],
        },
      });

      const done = yield* agents.waitForRun("run-1", {
        timeoutMillis: 5_000,
        pollIntervalMillis: 250,
      });

      assert.equal(done.status, "COMPLETED");
      assert.equal(polls, 2);

      const foreign = yield* failure(
        agents.run({
          task: "x",
          browserSettings: {
            context: {
              reference: ContextReference.make({ ...reference, projectId: "project-2" }),
              persist: true,
            },
          },
        }),
      );

      assert.deepEqual([foreign.reason, foreign.outcome], ["authorization", "undispatched"]);

      failStart = true;
      const before = seen.length;
      const lost = yield* failure(agents.run({ task: "x" }));

      assert.equal(lost.outcome, "unknown");
      assert.equal(seen.length, before + 1);
    }),
  );
});

it.effect("function invocations map session parameters and verify project identity", () => {
  let projectId = "project-1";

  const invocation = (status: string) => ({
    id: "inv-1",
    projectId,
    functionId: "fn-1",
    versionId: "ver-1",
    sessionId: "session-9",
    status,
    results: { price: 10 },
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: stamp,
    expiresAt: stamp,
  });

  const { seen, run } = provider(({ method, path }) =>
    path.endsWith("/logs")
      ? Response.json({ logs: [{ message: "hello", timestamp: 1 }], total: 1 })
      : method === "POST"
        ? Response.json(invocation("PENDING"), { status: 202 })
        : Response.json(invocation("COMPLETED")),
  );

  return run(
    Effect.gen(function* () {
      const functions = yield* BrowserbaseFunctions;

      yield* functions.invoke("fn-1", {
        params: { sku: "A1" },
        session: {
          timeout: 120,
          browserSettings: { size: "large", enablePdfViewer: true, extensions: ["browser-events"] },
        },
      });

      assert.deepEqual(seen[0], {
        method: "POST",
        path: "/v1/functions/fn-1/invoke",
        body: {
          params: { sku: "A1" },
          sessionCreateParams: {
            timeout: 120,
            browserSettings: {
              size: "large",
              enablePdfViewer: true,
              extensions: ["browser-events"],
            },
          },
        },
      });

      const done = yield* functions.waitForInvocation("inv-1", { timeoutMillis: 1_000 });

      assert.deepEqual(done.results, { price: 10 });
      assert.equal((yield* functions.invocationLogs("inv-1")).items[0]?.message, "hello");

      const tooLong = yield* failure(functions.invoke("fn-1", { session: { timeout: 901 } }));

      assert.equal(tooLong.reason, "configuration");

      projectId = "project-2";
      assert.equal((yield* failure(functions.invocation("inv-1"))).reason, "malformed");
    }),
  );
});

it.effect("usage samples timestamp the decoded provider reply before the host write", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();

    let release: (response: Response) => void = () => {
      throw new Error("provider reply gate was not installed");
    };

    const reply = new Promise<Response>((resolve) => {
      release = resolve;
    });

    const writes: ProjectUsageObservation[] = [];

    const { seen, run } = provider(() => {
      Deferred.doneUnsafe(requested, Effect.void);

      return reply;
    });

    const write = (sample: ProjectUsageObservation) =>
      Effect.sync(() => {
        writes.push(sample);
      });

    yield* TestClock.setTime(1_000);
    const reading = yield* run(sampleProjectUsage(write)).pipe(Effect.forkChild);

    yield* Deferred.await(requested);
    assert.equal(writes.length, 0);

    yield* TestClock.setTime(2_000);
    release(Response.json({ browserMinutes: 42, proxyBytes: 7 }));

    const sample = yield* Fiber.join(reading);
    const encoded = yield* Schema.encodeEffect(ProjectUsageObservation)(sample);

    assert.equal(DateTime.toEpochMillis(sample.observedAt), 2_000);
    assert.deepEqual(encoded, {
      source: "browserbase-project-usage",
      usage: { projectId: "project-1", browserMinutes: 42, proxyBytes: 7 },
      observedAt: "1970-01-01T00:00:02.000Z",
    });
    assert.equal(
      (yield* Schema.decodeEffect(ProjectUsageObservation)(encoded)).usage.browserMinutes,
      42,
    );
    assert.equal(writes.length, 1);
    assert.deepEqual(
      seen.map(({ method, path }) => [method, path]),
      [["GET", "/v1/projects/project-1/usage"]],
    );

    const malformed = provider(() => Response.json({ browserMinutes: "42", proxyBytes: 7 }));
    const failed = yield* malformed.run(sampleProjectUsage(write)).pipe(Effect.result);

    assert.equal(failed._tag, "Failure");
    assert.equal(writes.length, 1);
    assert.equal(malformed.seen.length, 1);
  }),
);

it.effect("the example journals typed Search, Fetch and Agent outcomes without replay", () => {
  const order: string[] = [];
  const starts: number[] = [];
  const observations: LocalOperationObservation[] = [];

  const { seen, run } = provider(({ path }) => {
    order.push(`request:${path}`);

    if (path === "/v1/search")
      return Response.json({ requestId: "r-1", query: "private query", results: [] });

    if (path === "/v1/fetch")
      return Response.json({
        id: "f-1",
        statusCode: 404,
        headers: {},
        content: "not found",
        contentType: "text/markdown",
        encoding: "utf-8",
      });

    return new Response("{}", { status: 502 });
  });

  const journal = {
    begin: (identity: { readonly operation: string }, startedAt: DateTime.Utc) =>
      Effect.sync(() => {
        order.push(`begin:${identity.operation}`);
        starts.push(DateTime.toEpochMillis(startedAt));

        return `intent-${order.length}`;
      }),
    finish: (_id: string, observation: LocalOperationObservation) =>
      Effect.sync(() => {
        order.push(`finish:${observation.operation}`);
        observations.push(observation);
      }),
  };

  return run(
    Effect.gen(function* () {
      yield* TestClock.setTime(123);

      const found = yield* observeSearch({ query: "private query" }, journal);

      const refused = yield* observePageFetch({ url: "file:///private" }, journal).pipe(
        Effect.result,
      );

      const fetched = yield* observePageFetch(
        { url: "https://private.example", format: "markdown", proxies: true },
        journal,
      );

      const uncertain = yield* observeAgentRun({ task: "private task" }, journal).pipe(
        Effect.result,
      );

      assert.equal(found.requestId, "r-1");
      assert.equal(refused._tag, "Failure");
      if (refused._tag === "Failure") assert.equal(refused.failure.outcome, "undispatched");
      assert.equal(fetched.statusCode, 404);
      assert.equal(uncertain._tag, "Failure");
      if (uncertain._tag === "Failure") assert.equal(uncertain.failure.outcome, "unknown");
      assert.deepEqual(
        observations.map(({ operation, outcome }) => [operation, outcome]),
        [
          ["search-web", "api-reply"],
          ["fetch", "undispatched"],
          ["fetch", "api-reply"],
          ["agent-run", "unknown"],
        ],
      );
      assert.deepEqual(
        [observations[2]?.requestedFormat, observations[2]?.requestedProxies],
        ["markdown", true],
      );
      assert.deepEqual(order, [
        "begin:search-web",
        "request:/v1/search",
        "finish:search-web",
        "begin:fetch",
        "finish:fetch",
        "begin:fetch",
        "request:/v1/fetch",
        "finish:fetch",
        "begin:agent-run",
        "request:/v1/agents/runs",
        "finish:agent-run",
      ]);
      assert.deepEqual(
        seen.map(({ method, path }) => [method, path]),
        [
          ["POST", "/v1/search"],
          ["POST", "/v1/fetch"],
          ["POST", "/v1/agents/runs"],
        ],
      );
      assert.equal(JSON.stringify(observations).includes("private"), false);
      assert.ok(starts.every((time) => time === 123));

      const before = seen.length;

      const blocked = yield* observeSearch(
        { query: "never sent" },
        { ...journal, begin: () => Effect.fail("journal-unavailable" as const) },
      ).pipe(Effect.result);

      assert.equal(blocked._tag, "Failure");
      if (blocked._tag === "Failure") assert.equal(blocked.failure, "journal-unavailable");
      assert.equal(seen.length, before);

      const malformed = yield* observePageFetch(null as never, journal).pipe(Effect.result);

      assert.equal(malformed._tag, "Failure");
      if (malformed._tag === "Failure") assert.equal(malformed.failure.outcome, "undispatched");
      assert.equal(seen.length, before);
    }),
  );
});

it.effect("a failed journal settlement preserves the original platform failure", () => {
  const { seen, run } = provider(() => new Response("{}", { status: 502 }));

  return run(
    Effect.gen(function* () {
      const result = yield* observePageFetch(
        { url: "file:///private" },
        {
          begin: () => Effect.succeed("intent-1"),
          finish: () => Effect.fail("sink-unavailable" as const),
        },
      ).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.service, "fetch");
        assert.equal(result.failure.outcome, "undispatched");
      }
      assert.equal(seen.length, 0);
    }),
  );
});

it.effect("a provider refusal is journaled as rejected without inferring billing", () => {
  const observations: LocalOperationObservation[] = [];
  const { seen, run } = provider(() => new Response("{}", { status: 429 }));

  return run(
    Effect.gen(function* () {
      const result = yield* observeSearch(
        { query: "private query" },
        {
          begin: () => Effect.succeed("intent-1"),
          finish: (_id, observation) =>
            Effect.sync(() => {
              observations.push(observation);
            }),
        },
      ).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.outcome, "rejected");
      assert.equal(observations[0]?.outcome, "rejected");
      assert.equal(seen.length, 1);
    }),
  );
});

it.effect("interruption settles a journal intent as unknown", () => {
  const observations: LocalOperationObservation[] = [];
  const { run } = provider(() => new Promise<Response>(() => {}));

  return run(
    Effect.gen(function* () {
      const began = yield* Deferred.make<void>();

      const fiber = yield* observeSearch(
        { query: "private query" },
        {
          begin: () => Deferred.succeed(began, undefined).pipe(Effect.as("intent-1")),
          finish: (_id, observation) =>
            Effect.sync(() => {
              observations.push(observation);
            }),
        },
      ).pipe(Effect.forkChild);

      yield* Deferred.await(began);
      yield* Fiber.interrupt(fiber);

      assert.equal(observations[0]?.outcome, "unknown");
    }),
  );
});

it.effect("allowance assessment needs verified, fresh provider period evidence", () =>
  Effect.gen(function* () {
    const allowance = {
      accountOrPlanScope: "account-plan-1",
      meter: "fetch-calls",
      unit: "calls",
      periodStart: "1970-01-01T00:00:00.000Z",
      periodEnd: "1970-01-01T00:00:01.000Z",
      includedQuantity: 1_000,
      alertAtConsumedQuantity: 700,
      maxToDateLagMillis: 200,
    };

    const total = {
      source: "provider-billing",
      accountOrPlanScope: "account-plan-1",
      meter: "fetch-calls",
      unit: "calls",
      periodStart: "1970-01-01T00:00:00.000Z",
      periodEnd: "1970-01-01T00:00:01.000Z",
      consumedQuantity: 720,
      measuredThrough: "1970-01-01T00:00:00.400Z",
      receivedAt: "1970-01-01T00:00:00.450Z",
      status: "to-date",
    };

    const decodeTotal = (record: unknown) =>
      Option.getOrThrow(Schema.decodeUnknownOption(ProviderPeriodConsumption)(record));

    assert.ok(
      Option.isNone(
        Schema.decodeUnknownOption(ProviderPeriodConsumption)({
          ...total,
          measuredThrough: "1970-01-01T00:00:00.400",
        }),
      ),
    );

    const trustedRecords = new Set<object>();

    const importTrusted = (record: unknown) => {
      const decoded = decodeTotal(record);

      trustedRecords.add(decoded);

      return decoded;
    };

    const assess = (plan: unknown, record: unknown) =>
      assessAllowance(plan, record, (decoded) => Effect.succeed(trustedRecords.has(decoded)));

    const trustedTotal = importTrusted(total);

    yield* TestClock.setTime(500);

    assert.deepEqual(yield* assess(allowance, undefined), {
      _tag: "Unknown",
      reason: "missing-provider-total",
    });
    assert.deepEqual(yield* assess(allowance, { browserMinutes: 42, proxyBytes: 7 }), {
      _tag: "Unknown",
      reason: "invalid-provider-total",
    });
    assert.deepEqual(
      yield* assess(allowance, importTrusted({ ...total, accountOrPlanScope: "other" })),
      {
        _tag: "Unknown",
        reason: "scope-or-unit-mismatch",
      },
    );
    assert.deepEqual(
      yield* assess(allowance, importTrusted({ ...total, periodEnd: "1970-01-01T00:00:02.000Z" })),
      { _tag: "Unknown", reason: "period-mismatch" },
    );
    assert.deepEqual(yield* assess(allowance, decodeTotal(total)), {
      _tag: "Unknown",
      reason: "unverified-provider-total",
    });
    assert.deepEqual(yield* assess({ ...allowance, periodStart: null }, trustedTotal), {
      _tag: "Unknown",
      reason: "invalid-allowance",
    });
    assert.deepEqual(yield* assess(allowance, trustedTotal), {
      _tag: "Known",
      source: "provider-billing",
      assessedAt: DateTime.makeUnsafe(500),
      measuredThrough: DateTime.makeUnsafe(400),
      status: "to-date",
      consumedQuantity: 720,
      remainingIncluded: 280,
      overIncluded: 0,
      alert: true,
    });

    assert.deepEqual(
      yield* assessAllowance(allowance, trustedTotal, (decoded) =>
        TestClock.adjust(101).pipe(Effect.as(trustedRecords.has(decoded))),
      ),
      { _tag: "Unknown", reason: "stale-provider-total" },
    );

    yield* TestClock.setTime(601);

    assert.deepEqual(yield* assess(allowance, trustedTotal), {
      _tag: "Unknown",
      reason: "stale-provider-total",
    });

    const verifying = yield* assessAllowance(allowance, trustedTotal, () => Effect.never).pipe(
      Effect.forkChild,
    );

    yield* TestClock.adjust("5 seconds");

    assert.deepEqual(yield* Fiber.join(verifying), {
      _tag: "Unknown",
      reason: "verification-timeout",
    });

    const final = {
      ...total,
      status: "final",
      consumedQuantity: 1_001,
      measuredThrough: "1970-01-01T00:00:01.000Z",
      receivedAt: "1970-01-01T00:00:01.100Z",
    };

    yield* TestClock.setTime(1_200);

    assert.deepEqual(yield* assess(allowance, importTrusted(final)), {
      _tag: "Known",
      source: "provider-billing",
      assessedAt: DateTime.makeUnsafe(1_200),
      measuredThrough: DateTime.makeUnsafe(1_000),
      status: "final",
      consumedQuantity: 1_001,
      remainingIncluded: 0,
      overIncluded: 1,
      alert: true,
    });
    assert.deepEqual(
      yield* assess(
        allowance,
        importTrusted({ ...final, measuredThrough: "1970-01-01T00:00:01.001Z" }),
      ),
      { _tag: "Unknown", reason: "period-not-final" },
    );
  }),
);
