import { Clock, Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { PlatformError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";
import { proxy } from "./internal/provider/Launch.ts";
import { isContextWriterBusy } from "./internal/session/ContextWriter.ts";
import { ProxyRule } from "./Launch.ts";
import { ContextReference, Identifier } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const Cursor = Schema.NonEmptyString.check(Schema.isMaxLength(4096));
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Prompt = Schema.String.check(Schema.isMaxLength(100_000));

export const AgentRunStatus = Schema.Literals([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "STOPPED",
  "TIMED_OUT",
]);

export type AgentRunStatus = typeof AgentRunStatus.Type;

export const isTerminalAgentRunStatus = (status: AgentRunStatus): boolean =>
  status !== "PENDING" && status !== "RUNNING";

export class AgentMetadata extends Schema.Class<AgentMetadata>("BrowserbaseAgentMetadata")({
  agentId: Identifier,
  name: Schema.String.check(Schema.isMaxLength(255)),
  systemPrompt: Schema.optionalKey(Prompt),
  resultSchema: Schema.optionalKey(JsonObject),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class AgentRun extends Schema.Class<AgentRun>("BrowserbaseAgentRun")({
  runId: Identifier,
  agentId: Schema.optionalKey(Identifier),
  task: Prompt,
  status: AgentRunStatus,
  sessionId: Schema.optionalKey(Identifier),
  sandboxId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  resultSchema: Schema.optionalKey(JsonObject),
  result: Schema.optionalKey(JsonObject),
  cause: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String.check(Schema.isMaxLength(64)),
      message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
    }),
  ),
  startedAt: Schema.optionalKey(Timestamp),
  endedAt: Schema.optionalKey(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class AgentRunMessage extends Schema.Class<AgentRunMessage>("BrowserbaseAgentRunMessage")({
  id: Schema.String.check(Schema.isMaxLength(256)),
  createdAt: Timestamp,
  role: Schema.Literals(["assistant", "tool"]),
  content: Schema.Json,
}) {}

export const AgentDefinition = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(255)),
  systemPrompt: Schema.optionalKey(Prompt),
  resultSchema: Schema.optionalKey(JsonObject),
});

export type AgentDefinition = typeof AgentDefinition.Type;

export const AgentUpdate = Schema.Struct({
  name: Schema.optionalKey(AgentDefinition.fields.name),
  systemPrompt: Schema.optionalKey(Prompt),
  resultSchema: Schema.optionalKey(JsonObject),
});

export type AgentUpdate = typeof AgentUpdate.Type;

export const AgentRunRequest = Schema.Struct({
  task: Schema.NonEmptyString.check(Schema.isMaxLength(100_000)),
  agentId: Schema.optionalKey(Identifier),
  resultSchema: Schema.optionalKey(JsonObject),
  variables: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMaxLength(128)),
      Schema.Struct({
        value: Schema.String.check(Schema.isMaxLength(100_000)),
        description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
      }),
    ),
  ),
  browserSettings: Schema.optionalKey(
    Schema.Struct({
      /**
       * A persisting run writes the Context from Browserbase's side, outside
       * `ContextCoordination.withWriter`. It is refused while a local writer holds the
       * Context, but nothing stops a later local writer from racing the hosted run.
       */
      context: Schema.optionalKey(
        Schema.Struct({ reference: ContextReference, persist: Schema.Boolean }),
      ),
      proxies: Schema.optionalKey(
        Schema.Union([Schema.Boolean, Schema.Array(ProxyRule).check(Schema.isMaxLength(64))]),
      ),
      verified: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

export type AgentRunRequest = typeof AgentRunRequest.Type;

const Window = {
  startAt: Schema.optionalKey(Timestamp),
  endAt: Schema.optionalKey(Timestamp),
  cursor: Schema.optionalKey(Cursor),
};

export const AgentListQuery = Schema.Struct({
  ...Window,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});

export type AgentListQuery = typeof AgentListQuery.Type;

export const AgentRunListQuery = Schema.Struct({
  ...Window,
  status: Schema.optionalKey(AgentRunStatus),
  agentId: Schema.optionalKey(Identifier),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});

export type AgentRunListQuery = typeof AgentRunListQuery.Type;

export const AgentMessageQuery = Schema.Struct({
  since: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  all: Schema.optionalKey(Schema.Boolean),
});

export type AgentMessageQuery = typeof AgentMessageQuery.Type;

export const AgentRunWaitOptions = Schema.Struct({
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 21_600_000 })),
  pollIntervalMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 250, maximum: 60_000 })),
  ),
});

export type AgentRunWaitOptions = typeof AgentRunWaitOptions.Type;

export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor: string | undefined;
}

export interface AgentMessages {
  readonly messages: ReadonlyArray<AgentRunMessage>;
  readonly nextSince: string | undefined;
}

const ProviderAgent = Schema.Struct({
  agentId: Identifier,
  name: AgentMetadata.fields.name,
  systemPrompt: Schema.optionalKey(Prompt),
  resultSchema: Schema.optionalKey(JsonObject),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const ProviderPage = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    data: Schema.Array(item).check(Schema.isMaxLength(1000)),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
  });

const ProviderMessages = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: AgentRunMessage.fields.id,
      createdAt: Timestamp,
      message: Schema.Struct({ role: AgentRunMessage.fields.role, content: Schema.Json }),
    }),
  ).check(Schema.isMaxLength(100)),
  nextSince: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
});

const now = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1_000_000));

/**
 * Browserbase Agents: hosted autonomous runs that allocate their own browser sessions and
 * bill inference. Creating or stopping a run is never retried; a lost reply is `unknown`.
 */
export class BrowserbaseAgents extends Context.Service<
  BrowserbaseAgents,
  {
    readonly create: (definition: AgentDefinition) => Effect.Effect<AgentMetadata, PlatformError>;
    readonly list: (query?: AgentListQuery) => Effect.Effect<Page<AgentMetadata>, PlatformError>;
    readonly retrieve: (agentId: string) => Effect.Effect<AgentMetadata, PlatformError>;
    readonly update: (
      agentId: string,
      update: AgentUpdate,
    ) => Effect.Effect<AgentMetadata, PlatformError>;
    readonly delete: (agentId: string) => Effect.Effect<void, PlatformError>;
    readonly run: (request: AgentRunRequest) => Effect.Effect<AgentRun, PlatformError>;
    readonly retrieveRun: (runId: string) => Effect.Effect<AgentRun, PlatformError>;
    readonly listRuns: (query?: AgentRunListQuery) => Effect.Effect<Page<AgentRun>, PlatformError>;
    readonly stopRun: (runId: string) => Effect.Effect<AgentRun, PlatformError>;
    readonly messages: (
      runId: string,
      query?: AgentMessageQuery,
    ) => Effect.Effect<AgentMessages, PlatformError>;
    /** Polls until the run is terminal. Interrupting the wait does not stop the run. */
    readonly waitForRun: (
      runId: string,
      options: AgentRunWaitOptions,
    ) => Effect.Effect<AgentRun, PlatformError>;
  }
>()("effect-browserbase/Agents") {
  static readonly layer: Layer.Layer<BrowserbaseAgents, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseAgents,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const api = resource<PlatformError>(client, (failure) =>
        PlatformError.make({ ...failure, service: "agents" }),
      );

      const agentPath = (id: string) => `/v1/agents/${api.segment(id)}`;
      const runPath = (id: string) => `/v1/agents/runs/${api.segment(id)}`;

      const agent = (operation: PlatformError["operation"], mutation: boolean, expected?: string) =>
        Effect.fnUntraced(function* (value: typeof ProviderAgent.Type) {
          if (expected !== undefined && value.agentId !== expected)
            return yield* api.malformed(operation, mutation);

          return AgentMetadata.make(value);
        });

      const run = (operation: PlatformError["operation"], mutation: boolean, expected?: string) =>
        Effect.fnUntraced(function* (value: AgentRun) {
          if (expected !== undefined && value.runId !== expected)
            return yield* api.malformed(operation, mutation);

          return value;
        });

      const create = Effect.fn("BrowserbaseAgents.create")(function* (definition: AgentDefinition) {
        const value = yield* api.input(AgentDefinition, definition, "agent-create");

        return yield* api
          .request("POST", "/v1/agents", ProviderAgent, "agent-create", value)
          .pipe(Effect.flatMap(agent("agent-create", true)));
      });

      const list = Effect.fn("BrowserbaseAgents.list")(function* (query: AgentListQuery = {}) {
        const value = yield* api.input(AgentListQuery, query, "agent-list");

        const page = yield* api.request(
          "GET",
          `/v1/agents${api.query(value)}`,
          ProviderPage(ProviderAgent),
          "agent-list",
        );

        return {
          items: page.data.map((row) => AgentMetadata.make(row)),
          nextCursor: page.nextCursor ?? undefined,
        };
      });

      const retrieve = Effect.fn("BrowserbaseAgents.retrieve")(function* (agentId: string) {
        const id = yield* api.input(Identifier, agentId, "agent-retrieve");

        return yield* api
          .request("GET", agentPath(id), ProviderAgent, "agent-retrieve")
          .pipe(Effect.flatMap(agent("agent-retrieve", false, id)));
      });

      const update = Effect.fn("BrowserbaseAgents.update")(function* (
        agentId: string,
        changes: AgentUpdate,
      ) {
        const id = yield* api.input(Identifier, agentId, "agent-update");
        const value = yield* api.input(AgentUpdate, changes, "agent-update");

        if (Object.keys(value).length === 0) return yield* api.configuration("agent-update");

        return yield* api
          .request("PATCH", agentPath(id), ProviderAgent, "agent-update", value)
          .pipe(Effect.flatMap(agent("agent-update", true, id)));
      });

      const remove = Effect.fn("BrowserbaseAgents.delete")(function* (agentId: string) {
        const id = yield* api.input(Identifier, agentId, "agent-delete");

        yield* api.remove(agentPath(id), "agent-delete");
      });

      const start = Effect.fn("BrowserbaseAgents.run")(function* (request: AgentRunRequest) {
        const value = yield* api.input(AgentRunRequest, request, "agent-run");
        const settings = value.browserSettings;
        const context = settings?.context;

        if (context !== undefined) {
          if (context.reference.projectId !== client.projectId)
            return yield* api.make({
              operation: "agent-run",
              reason: "authorization",
              outcome: "undispatched",
            });
          if (context.persist && isContextWriterBusy(context.reference))
            return yield* api.make({
              operation: "agent-run",
              reason: "active",
              outcome: "undispatched",
            });
        }

        const body: Schema.Json = {
          task: value.task,
          ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
          ...(value.resultSchema === undefined ? {} : { resultSchema: value.resultSchema }),
          ...(value.variables === undefined ? {} : { variables: value.variables }),
          ...(settings === undefined
            ? {}
            : {
                browserSettings: {
                  ...(context === undefined
                    ? {}
                    : {
                        context: { id: context.reference.contextId, persist: context.persist },
                      }),
                  ...(settings.proxies === undefined
                    ? {}
                    : {
                        proxies:
                          typeof settings.proxies === "boolean"
                            ? settings.proxies
                            : settings.proxies.map(proxy),
                      }),
                  ...(settings.verified === undefined ? {} : { verified: settings.verified }),
                },
              }),
        };

        return yield* api.request("POST", "/v1/agents/runs", AgentRun, "agent-run", body);
      });

      const retrieveRun = Effect.fn("BrowserbaseAgents.retrieveRun")(function* (runId: string) {
        const id = yield* api.input(Identifier, runId, "agent-run-retrieve");

        return yield* api
          .request("GET", runPath(id), AgentRun, "agent-run-retrieve")
          .pipe(Effect.flatMap(run("agent-run-retrieve", false, id)));
      });

      const listRuns = Effect.fn("BrowserbaseAgents.listRuns")(function* (
        query: AgentRunListQuery = {},
      ) {
        const value = yield* api.input(AgentRunListQuery, query, "agent-run-list");

        const page = yield* api.request(
          "GET",
          `/v1/agents/runs${api.query(value)}`,
          ProviderPage(AgentRun),
          "agent-run-list",
        );

        return { items: page.data, nextCursor: page.nextCursor ?? undefined };
      });

      const stopRun = Effect.fn("BrowserbaseAgents.stopRun")(function* (runId: string) {
        const id = yield* api.input(Identifier, runId, "agent-run-stop");

        return yield* api
          .request("POST", `${runPath(id)}/stop`, AgentRun, "agent-run-stop")
          .pipe(Effect.flatMap(run("agent-run-stop", true, id)));
      });

      const messages = Effect.fn("BrowserbaseAgents.messages")(function* (
        runId: string,
        query: AgentMessageQuery = {},
      ) {
        const id = yield* api.input(Identifier, runId, "agent-run-messages");
        const value = yield* api.input(AgentMessageQuery, query, "agent-run-messages");

        const page = yield* api.request(
          "GET",
          `${runPath(id)}/messages${api.query(value)}`,
          ProviderMessages,
          "agent-run-messages",
        );

        return {
          messages: page.data.map((row) =>
            AgentRunMessage.make({
              id: row.id,
              createdAt: row.createdAt,
              role: row.message.role,
              content: row.message.content,
            }),
          ),
          nextSince: page.nextSince ?? undefined,
        };
      });

      const waitForRun = Effect.fn("BrowserbaseAgents.waitForRun")(function* (
        runId: string,
        options: AgentRunWaitOptions,
      ) {
        const bounds = yield* api.input(AgentRunWaitOptions, options, "agent-run-wait");
        const deadline = (yield* now) + bounds.timeoutMillis;

        for (;;) {
          const current = yield* retrieveRun(runId);

          if (isTerminalAgentRunStatus(current.status)) return current;
          const remaining = deadline - (yield* now);

          if (remaining <= 0)
            return yield* api.make({ operation: "agent-run-wait", reason: "timeout" });
          yield* Effect.sleep(Math.min(bounds.pollIntervalMillis ?? 2_000, remaining));
        }
      });

      return BrowserbaseAgents.of({
        create,
        list,
        retrieve,
        update,
        delete: remove,
        run: start,
        retrieveRun,
        listRuns,
        stopRun,
        messages,
        waitForRun,
      });
    }),
  );
}
