import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { ProjectError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";
import { Identifier } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));

export class ProjectMetadata extends Schema.Class<ProjectMetadata>("BrowserbaseProjectMetadata")({
  projectId: Identifier,
  name: Schema.String.check(Schema.isMaxLength(1024)),
  ownerId: Schema.String.check(Schema.isMaxLength(256)),
  /** Default provider session lifetime in seconds. */
  defaultTimeout: Schema.Int,
  /** Maximum concurrent sessions. */
  concurrency: Schema.Int,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export class ProjectUsage extends Schema.Class<ProjectUsage>("BrowserbaseProjectUsage")({
  projectId: Identifier,
  browserMinutes: Schema.Natural,
  proxyBytes: Schema.Natural,
}) {}

const ProviderProject = Schema.Struct({
  id: Identifier,
  name: ProjectMetadata.fields.name,
  ownerId: ProjectMetadata.fields.ownerId,
  defaultTimeout: Schema.Int,
  concurrency: Schema.Int,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const project = ({ id, ...rest }: typeof ProviderProject.Type) =>
  ProjectMetadata.make({ projectId: id, ...rest });

/**
 * Passive project inspection. `retrieve` and `usage` read the Client's own project; `list`
 * reports every project the API key can see. Nothing here changes provider state.
 */
export class BrowserbaseProjects extends Context.Service<
  BrowserbaseProjects,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProjectMetadata>, ProjectError>;
    readonly retrieve: Effect.Effect<ProjectMetadata, ProjectError>;
    readonly usage: Effect.Effect<ProjectUsage, ProjectError>;
  }
>()("effect-browserbase/Projects") {
  static readonly layer: Layer.Layer<BrowserbaseProjects, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseProjects,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const api = resource(client, (failure) => ProjectError.make(failure));
      const own = `/v1/projects/${api.segment(client.projectId)}`;

      const list = api
        .request(
          "GET",
          "/v1/projects",
          Schema.Array(ProviderProject).check(Schema.isMaxLength(1024)),
          "project-list",
        )
        .pipe(
          Effect.map((rows) => rows.map(project)),
          Effect.withSpan("BrowserbaseProjects.list"),
        );

      const retrieve = api.request("GET", own, ProviderProject, "project-retrieve").pipe(
        Effect.flatMap((value) =>
          value.id === client.projectId
            ? Effect.succeed(project(value))
            : Effect.fail(api.malformed("project-retrieve", false)),
        ),
        Effect.withSpan("BrowserbaseProjects.retrieve"),
      );

      const usage = api
        .request(
          "GET",
          `${own}/usage`,
          Schema.Struct({ browserMinutes: Schema.Natural, proxyBytes: Schema.Natural }),
          "project-usage",
        )
        .pipe(
          Effect.map((value) => ProjectUsage.make({ projectId: client.projectId, ...value })),
          Effect.withSpan("BrowserbaseProjects.usage"),
        );

      return BrowserbaseProjects.of({ list, retrieve, usage });
    }),
  );
}
