import { Clock, Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { PlatformError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";
import { proxy } from "./internal/provider/Launch.ts";
import { isContextWriterBusy } from "./internal/session/ContextWriter.ts";
import { ProxyRule } from "./Launch.ts";
import { ContextReference, Identifier } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Name = Schema.String.check(Schema.isMaxLength(1024));
const Status = Schema.Literals(["PENDING", "RUNNING", "COMPLETED", "FAILED"]);

export type FunctionStatus = typeof Status.Type;

export class FunctionMetadata extends Schema.Class<FunctionMetadata>("BrowserbaseFunctionMetadata")(
  {
    id: Identifier,
    projectId: Identifier,
    name: Name,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  },
) {}

export class FunctionVersion extends Schema.Class<FunctionVersion>("BrowserbaseFunctionVersion")({
  id: Identifier,
  projectId: Identifier,
  functionId: Identifier,
  functionBuildId: Identifier,
  sessionCreateParams: Schema.optionalKey(JsonObject),
  userParamsSchema: Schema.optionalKey(JsonObject),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class FunctionBuild extends Schema.Class<FunctionBuild>("BrowserbaseFunctionBuild")({
  id: Identifier,
  projectId: Identifier,
  request: Schema.Struct({
    entrypoint: Name,
    functionNames: Schema.optionalKey(Schema.Array(Name).check(Schema.isMaxLength(1024))),
  }),
  status: Status,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  expiresAt: Timestamp,
  cause: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String.check(Schema.isMaxLength(64)),
      message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    }),
  ),
}) {}

export class FunctionInvocation extends Schema.Class<FunctionInvocation>(
  "BrowserbaseFunctionInvocation",
)({
  id: Identifier,
  projectId: Identifier,
  functionId: Identifier,
  versionId: Identifier,
  sessionId: Identifier,
  region: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  params: Schema.optionalKey(JsonObject),
  status: Status,
  results: Schema.optionalKey(Schema.Json),
  cause: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String.check(Schema.isMaxLength(64)),
      message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    }),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  expiresAt: Timestamp,
}) {}

export class FunctionLogLine extends Schema.Class<FunctionLogLine>("BrowserbaseFunctionLogLine")({
  message: Schema.String.check(Schema.isMaxLength(65_536)),
  timestamp: Schema.Finite,
}) {}

/** The session a Function invocation runs in; the provider's invoke-time subset. */
export const FunctionSessionParams = Schema.Struct({
  /** Seconds, 60–900; the provider defaults to 900. */
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 900 }))),
  extensionId: Schema.optionalKey(Identifier),
  context: Schema.optionalKey(
    Schema.Struct({ reference: ContextReference, persist: Schema.Boolean }),
  ),
  proxies: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Array(ProxyRule).check(Schema.isMaxLength(64))]),
  ),
  proxySettings: Schema.optionalKey(
    Schema.Struct({
      caCertificates: Schema.optionalKey(
        Schema.Array(Identifier).check(Schema.isMaxLength(64), Schema.isUnique()),
      ),
    }),
  ),
  userMetadata: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isMaxLength(128)), Schema.Json),
  ),
  browserSettings: Schema.optionalKey(
    Schema.Struct({
      viewport: Schema.optionalKey(
        Schema.Struct({
          width: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
          ),
          height: Schema.optionalKey(
            Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
          ),
        }),
      ),
      blockAds: Schema.optionalKey(Schema.Boolean),
      solveCaptchas: Schema.optionalKey(Schema.Boolean),
      recordSession: Schema.optionalKey(Schema.Boolean),
      logSession: Schema.optionalKey(Schema.Boolean),
      verified: Schema.optionalKey(Schema.Boolean),
      captchaImageSelector: Schema.optionalKey(
        Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
      ),
      captchaInputSelector: Schema.optionalKey(
        Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
      ),
      os: Schema.optionalKey(Schema.Literals(["windows", "mac", "linux", "mobile", "tablet"])),
      size: Schema.optionalKey(Schema.Literals(["small", "medium", "large"])),
      enableNativeSelectPolyfill: Schema.optionalKey(Schema.Boolean),
      enablePdfViewer: Schema.optionalKey(Schema.Boolean),
      extensions: Schema.optionalKey(
        Schema.Array(Schema.Literals(["onepassword", "browser-events"])).check(Schema.isUnique()),
      ),
      allowedDomains: Schema.optionalKey(
        Schema.Array(Schema.NonEmptyString.check(Schema.isMaxLength(1024))).check(
          Schema.isMaxLength(64),
          Schema.isUnique(),
        ),
      ),
      ignoreCertificateErrors: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export type FunctionSessionParams = typeof FunctionSessionParams.Type;

export const FunctionInvokeRequest = Schema.Struct({
  params: Schema.optionalKey(JsonObject),
  session: Schema.optionalKey(FunctionSessionParams),
});

export type FunctionInvokeRequest = typeof FunctionInvokeRequest.Type;

const Offset = {
  offset: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};

export const FunctionPageQuery = Schema.Struct(Offset);
export type FunctionPageQuery = typeof FunctionPageQuery.Type;

export const FunctionStatusQuery = Schema.Struct({ ...Offset, status: Schema.optionalKey(Status) });
export type FunctionStatusQuery = typeof FunctionStatusQuery.Type;

export const FunctionWaitOptions = Schema.Struct({
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600_000 })),
  pollIntervalMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 250, maximum: 60_000 })),
  ),
});

export type FunctionWaitOptions = typeof FunctionWaitOptions.Type;

export interface OffsetPage<A> {
  readonly items: ReadonlyArray<A>;
  readonly total: number;
}

const DataPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ data: Schema.Array(item).check(Schema.isMaxLength(100)), total: Schema.Natural });

const ResultsPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item).check(Schema.isMaxLength(100)),
    total: Schema.Natural,
  });

const Logs = Schema.Struct({
  logs: Schema.Array(FunctionLogLine).check(Schema.isMaxLength(100_000)),
  total: Schema.Natural,
});

const now = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1_000_000));

/**
 * Browserbase Functions: deployed code invoked in a provider-allocated session. Deployment
 * happens through Browserbase's CLI; this service reads, invokes and observes. `invoke` is
 * never retried, and a lost reply is `outcome: "unknown"`.
 */
export class BrowserbaseFunctions extends Context.Service<
  BrowserbaseFunctions,
  {
    readonly list: (
      query?: FunctionPageQuery,
    ) => Effect.Effect<OffsetPage<FunctionMetadata>, PlatformError>;
    readonly retrieve: (functionId: string) => Effect.Effect<FunctionMetadata, PlatformError>;
    readonly invoke: (
      functionId: string,
      request?: FunctionInvokeRequest,
    ) => Effect.Effect<FunctionInvocation, PlatformError>;
    readonly versions: (
      functionId: string,
      query?: FunctionPageQuery,
    ) => Effect.Effect<OffsetPage<FunctionVersion>, PlatformError>;
    readonly version: (versionId: string) => Effect.Effect<FunctionVersion, PlatformError>;
    readonly invocations: (
      versionId: string,
      query?: FunctionStatusQuery,
    ) => Effect.Effect<OffsetPage<FunctionInvocation>, PlatformError>;
    readonly invocation: (invocationId: string) => Effect.Effect<FunctionInvocation, PlatformError>;
    readonly invocationLogs: (
      invocationId: string,
    ) => Effect.Effect<OffsetPage<FunctionLogLine>, PlatformError>;
    readonly builds: (
      query?: FunctionStatusQuery,
    ) => Effect.Effect<OffsetPage<FunctionBuild>, PlatformError>;
    readonly build: (buildId: string) => Effect.Effect<FunctionBuild, PlatformError>;
    readonly buildLogs: (
      buildId: string,
    ) => Effect.Effect<OffsetPage<FunctionLogLine>, PlatformError>;
    /** Polls until the invocation is terminal. Interrupting the wait does not cancel it. */
    readonly waitForInvocation: (
      invocationId: string,
      options: FunctionWaitOptions,
    ) => Effect.Effect<FunctionInvocation, PlatformError>;
  }
>()("effect-browserbase/Functions") {
  static readonly layer: Layer.Layer<BrowserbaseFunctions, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseFunctions,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const api = resource<PlatformError>(client, (failure) =>
        PlatformError.make({ ...failure, service: "functions" }),
      );

      /** Every record names its project; a foreign or mismatched one is malformed. */
      const owned =
        <A extends { readonly id: string; readonly projectId: string }>(
          operation: PlatformError["operation"],
          mutation: boolean,
          expected?: string,
        ) =>
        (value: A): Effect.Effect<A, PlatformError> =>
          value.projectId === client.projectId && (expected === undefined || value.id === expected)
            ? Effect.succeed(value)
            : Effect.fail(api.malformed(operation, mutation));

      const id = (value: string, operation: PlatformError["operation"]) =>
        api.input(Identifier, value, operation);

      const list = Effect.fn("BrowserbaseFunctions.list")(function* (
        query: FunctionPageQuery = {},
      ) {
        const value = yield* api.input(FunctionPageQuery, query, "function-list");

        const page = yield* api.request(
          "GET",
          `/v1/functions${api.query(value)}`,
          DataPage(FunctionMetadata),
          "function-list",
        );

        return {
          items: yield* Effect.forEach(page.data, owned("function-list", false)),
          total: page.total,
        };
      });

      const retrieve = Effect.fn("BrowserbaseFunctions.retrieve")(function* (functionId: string) {
        const checked = yield* id(functionId, "function-retrieve");

        return yield* api
          .request(
            "GET",
            `/v1/functions/${api.segment(checked)}`,
            FunctionMetadata,
            "function-retrieve",
          )
          .pipe(Effect.flatMap(owned("function-retrieve", false, checked)));
      });

      const invoke = Effect.fn("BrowserbaseFunctions.invoke")(function* (
        functionId: string,
        request: FunctionInvokeRequest = {},
      ) {
        const checked = yield* id(functionId, "function-invoke");
        const value = yield* api.input(FunctionInvokeRequest, request, "function-invoke");
        const session = value.session;
        const context = session?.context;

        if (context !== undefined) {
          if (context.reference.projectId !== client.projectId)
            return yield* api.make({
              operation: "function-invoke",
              reason: "authorization",
              outcome: "undispatched",
            });
          if (context.persist && isContextWriterBusy(context.reference))
            return yield* api.make({
              operation: "function-invoke",
              reason: "active",
              outcome: "undispatched",
            });
        }

        const sessionCreateParams: Schema.Json | undefined =
          session === undefined
            ? undefined
            : {
                ...(session.timeout === undefined ? {} : { timeout: session.timeout }),
                ...(session.extensionId === undefined ? {} : { extensionId: session.extensionId }),
                ...(session.proxies === undefined
                  ? {}
                  : {
                      proxies:
                        typeof session.proxies === "boolean"
                          ? session.proxies
                          : session.proxies.map(proxy),
                    }),
                ...(session.proxySettings === undefined
                  ? {}
                  : { proxySettings: session.proxySettings }),
                ...(session.userMetadata === undefined
                  ? {}
                  : { userMetadata: session.userMetadata }),
                ...(session.browserSettings === undefined && context === undefined
                  ? {}
                  : {
                      browserSettings: {
                        ...session.browserSettings,
                        ...(context === undefined
                          ? {}
                          : {
                              context: {
                                id: context.reference.contextId,
                                persist: context.persist,
                              },
                            }),
                      },
                    }),
              };

        return yield* api
          .request(
            "POST",
            `/v1/functions/${api.segment(checked)}/invoke`,
            FunctionInvocation,
            "function-invoke",
            {
              ...(value.params === undefined ? {} : { params: value.params }),
              ...(sessionCreateParams === undefined ? {} : { sessionCreateParams }),
            },
          )
          .pipe(Effect.flatMap(owned("function-invoke", true)));
      });

      const versions = Effect.fn("BrowserbaseFunctions.versions")(function* (
        functionId: string,
        query: FunctionPageQuery = {},
      ) {
        const checked = yield* id(functionId, "function-versions");
        const value = yield* api.input(FunctionPageQuery, query, "function-versions");

        const page = yield* api.request(
          "GET",
          `/v1/functions/${api.segment(checked)}/versions${api.query(value)}`,
          ResultsPage(FunctionVersion),
          "function-versions",
        );

        return {
          items: yield* Effect.forEach(page.results, owned("function-versions", false)),
          total: page.total,
        };
      });

      const version = Effect.fn("BrowserbaseFunctions.version")(function* (versionId: string) {
        const checked = yield* id(versionId, "function-version");

        return yield* api
          .request(
            "GET",
            `/v1/functions/versions/${api.segment(checked)}`,
            FunctionVersion,
            "function-version",
          )
          .pipe(Effect.flatMap(owned("function-version", false, checked)));
      });

      const invocations = Effect.fn("BrowserbaseFunctions.invocations")(function* (
        versionId: string,
        query: FunctionStatusQuery = {},
      ) {
        const checked = yield* id(versionId, "function-invocations");
        const value = yield* api.input(FunctionStatusQuery, query, "function-invocations");

        const page = yield* api.request(
          "GET",
          `/v1/functions/versions/${api.segment(checked)}/invocations${api.query(value)}`,
          ResultsPage(FunctionInvocation),
          "function-invocations",
        );

        return {
          items: yield* Effect.forEach(page.results, owned("function-invocations", false)),
          total: page.total,
        };
      });

      const invocation = Effect.fn("BrowserbaseFunctions.invocation")(function* (
        invocationId: string,
      ) {
        const checked = yield* id(invocationId, "function-invocation");

        return yield* api
          .request(
            "GET",
            `/v1/functions/invocations/${api.segment(checked)}`,
            FunctionInvocation,
            "function-invocation",
          )
          .pipe(Effect.flatMap(owned("function-invocation", false, checked)));
      });

      const logs = (path: string, operation: PlatformError["operation"]) =>
        api
          .request("GET", path, Logs, operation)
          .pipe(Effect.map((value) => ({ items: value.logs, total: value.total })));

      const invocationLogs = Effect.fn("BrowserbaseFunctions.invocationLogs")(function* (
        invocationId: string,
      ) {
        const checked = yield* id(invocationId, "function-invocation-logs");

        return yield* logs(
          `/v1/functions/invocations/${api.segment(checked)}/logs`,
          "function-invocation-logs",
        );
      });

      const builds = Effect.fn("BrowserbaseFunctions.builds")(function* (
        query: FunctionStatusQuery = {},
      ) {
        const value = yield* api.input(FunctionStatusQuery, query, "function-builds");

        const page = yield* api.request(
          "GET",
          `/v1/functions/builds${api.query(value)}`,
          DataPage(FunctionBuild),
          "function-builds",
        );

        return {
          items: yield* Effect.forEach(page.data, owned("function-builds", false)),
          total: page.total,
        };
      });

      const build = Effect.fn("BrowserbaseFunctions.build")(function* (buildId: string) {
        const checked = yield* id(buildId, "function-build");

        return yield* api
          .request(
            "GET",
            `/v1/functions/builds/${api.segment(checked)}`,
            FunctionBuild,
            "function-build",
          )
          .pipe(Effect.flatMap(owned("function-build", false, checked)));
      });

      const buildLogs = Effect.fn("BrowserbaseFunctions.buildLogs")(function* (buildId: string) {
        const checked = yield* id(buildId, "function-build-logs");

        return yield* logs(
          `/v1/functions/builds/${api.segment(checked)}/logs`,
          "function-build-logs",
        );
      });

      const waitForInvocation = Effect.fn("BrowserbaseFunctions.waitForInvocation")(function* (
        invocationId: string,
        options: FunctionWaitOptions,
      ) {
        const bounds = yield* api.input(FunctionWaitOptions, options, "function-wait");
        const deadline = (yield* now) + bounds.timeoutMillis;

        for (;;) {
          const current = yield* invocation(invocationId);

          if (current.status === "COMPLETED" || current.status === "FAILED") return current;
          const remaining = deadline - (yield* now);

          if (remaining <= 0)
            return yield* api.make({ operation: "function-wait", reason: "timeout" });
          yield* Effect.sleep(Math.min(bounds.pollIntervalMillis ?? 1_000, remaining));
        }
      });

      return BrowserbaseFunctions.of({
        list,
        retrieve,
        invoke,
        versions,
        version,
        invocations,
        invocation,
        invocationLogs,
        builds,
        build,
        buildLogs,
        waitForInvocation,
      });
    }),
  );
}
