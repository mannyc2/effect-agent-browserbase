import { Config, Effect, Schema } from "effect";
import { ReleaseError } from "@mannyc1/ts-release";
import { ProvenanceSource } from "@mannyc1/ts-release-npm";

export const repository = "mannyc2/effect-agent-browserbase";
export const remote = `https://github.com/${repository}.git`;
export const workflow = ".github/workflows/publish.yml";
export const releaseNodeVersion = "22.22.2";
export const httpBounds = {
  timeoutMilliseconds: 30_000,
  maximumResponseBytes: 8 * 1024 * 1024,
};

const decimalId = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const sourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));

export class ReleaseInput extends Schema.Class<ReleaseInput>("ReleaseInput")({
  sourceSha: sourceCommit,
  tag: Schema.String,
  directory: Schema.NonEmptyString,
  cacheDirectory: Schema.NonEmptyString,
  artifacts: Schema.NonEmptyString,
  expectedDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  authorize: Schema.Boolean,
}) {}

function hostSchema(sourceSha: string, tag: string) {
  Schema.decodeSync(sourceCommit)(sourceSha);
  return Schema.Struct({
    GITHUB_ACTIONS: Schema.Literal("true"),
    NPM_PUBLISH_ENABLED: Schema.Literal("true"),
    GITHUB_SERVER_URL: Schema.Literal("https://github.com"),
    GITHUB_REPOSITORY: Schema.Literal(repository),
    GITHUB_SHA: Schema.Literal(sourceSha),
    GITHUB_REF: Schema.Literal(`refs/tags/${tag}`),
    GITHUB_WORKFLOW_REF: Schema.Literal(`${repository}/${workflow}@refs/tags/${tag}`),
    GITHUB_EVENT_NAME: Schema.Literal("workflow_dispatch"),
    RUNNER_ENVIRONMENT: Schema.Literal("github-hosted"),
    GITHUB_REPOSITORY_ID: decimalId,
    GITHUB_REPOSITORY_OWNER_ID: decimalId,
    GITHUB_RUN_ID: decimalId,
    GITHUB_RUN_ATTEMPT: decimalId,
  });
}

type HostIdentity = Schema.Schema.Type<ReturnType<typeof hostSchema>>;

export function checkHost(environment: unknown, sourceSha: string, tag: string): HostIdentity {
  return Schema.decodeUnknownSync(hostSchema(sourceSha, tag))(environment);
}

const configuration = Config.all({
  GITHUB_ACTIONS: Config.String("GITHUB_ACTIONS"),
  NPM_PUBLISH_ENABLED: Config.String("NPM_PUBLISH_ENABLED"),
  GITHUB_SERVER_URL: Config.String("GITHUB_SERVER_URL"),
  GITHUB_REPOSITORY: Config.String("GITHUB_REPOSITORY"),
  GITHUB_SHA: Config.String("GITHUB_SHA"),
  GITHUB_REF: Config.String("GITHUB_REF"),
  GITHUB_WORKFLOW_REF: Config.String("GITHUB_WORKFLOW_REF"),
  GITHUB_EVENT_NAME: Config.String("GITHUB_EVENT_NAME"),
  RUNNER_ENVIRONMENT: Config.String("RUNNER_ENVIRONMENT"),
  GITHUB_REPOSITORY_ID: Config.String("GITHUB_REPOSITORY_ID"),
  GITHUB_REPOSITORY_OWNER_ID: Config.String("GITHUB_REPOSITORY_OWNER_ID"),
  GITHUB_RUN_ID: Config.String("GITHUB_RUN_ID"),
  GITHUB_RUN_ATTEMPT: Config.String("GITHUB_RUN_ATTEMPT"),
});

/** Public identity is admitted before any credential or retained state is read. */
export const hostIdentity = Effect.fn("release.hostIdentity")(function* (
  sourceSha: string,
  tag: string,
) {
  const environment = yield* configuration;
  return yield* Effect.try({
    try: () => checkHost(environment, sourceSha, tag),
    catch: () =>
      new ReleaseError({
        code: "release-host-identity",
        message:
          "Publication requires the enabled GitHub-hosted workflow for the exact release tag and commit",
      }),
  });
});

export function provenanceSource(identity: HostIdentity, input: ReleaseInput): ProvenanceSource {
  return new ProvenanceSource({
    format: "npm-github-actions-provenance-source/v1",
    serverUrl: "https://github.com",
    repository,
    workflow,
    workflowRef: `refs/tags/${input.tag}`,
    sourceRef: `refs/tags/${input.tag}`,
    sourceCommit: input.sourceSha,
    eventName: "workflow_dispatch",
    repositoryId: identity.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: identity.GITHUB_REPOSITORY_OWNER_ID,
    runnerEnvironment: "github-hosted",
    runId: identity.GITHUB_RUN_ID,
    runAttempt: identity.GITHUB_RUN_ATTEMPT,
    repositoryVisibility: "public",
  });
}
