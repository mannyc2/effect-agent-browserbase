import assert from "node:assert/strict";
import { test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { checkHost, createApplication } from "./main.ts";

const sourceSha = "1234567890abcdef1234567890abcdef12345678";
const tag = "v0.1.0-beta.102";
const identity = {
  GITHUB_ACTIONS: "true",
  NPM_PUBLISH_ENABLED: "true",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "mannyc2/effect-agent-browserbase",
  GITHUB_SHA: sourceSha,
  GITHUB_REF: `refs/tags/${tag}`,
  GITHUB_WORKFLOW_REF: `mannyc2/effect-agent-browserbase/.github/workflows/publish.yml@refs/tags/${tag}`,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_REPOSITORY_ID: "1",
  GITHUB_REPOSITORY_OWNER_ID: "2",
  GITHUB_RUN_ID: "3",
  GITHUB_RUN_ATTEMPT: "1",
};
const mismatches = [
  ["source commit", "GITHUB_SHA", "f".repeat(40)],
  ["source ref", "GITHUB_REF", "refs/heads/main"],
  [
    "workflow",
    "GITHUB_WORKFLOW_REF",
    `mannyc2/effect-agent-browserbase/.github/workflows/ci.yml@refs/tags/${tag}`,
  ],
  [
    "workflow ref",
    "GITHUB_WORKFLOW_REF",
    "mannyc2/effect-agent-browserbase/.github/workflows/publish.yml@refs/heads/main",
  ],
  ["runner", "RUNNER_ENVIRONMENT", "self-hosted"],
  ["repository", "GITHUB_REPOSITORY", "someone-else/effect-agent-browserbase"],
  ["event", "GITHUB_EVENT_NAME", "pull_request"],
  ["publication opt-in", "NPM_PUBLISH_ENABLED", "false"],
  ["Actions host", "GITHUB_ACTIONS", "false"],
  ["GitHub server", "GITHUB_SERVER_URL", "https://github.example.com"],
];

function trackedConfiguration(environment) {
  const reads = [];
  const provider = ConfigProvider.make((path) =>
    Effect.sync(() => {
      const key = path.join(".");
      reads.push(key);
      const value = environment[key];
      return value === undefined ? undefined : ConfigProvider.makeValue(value);
    }),
  );
  return { reads, layer: ConfigProvider.layer(provider) };
}

// Accessors prove identity and configuration failures happen before even
// selecting local state paths, without mocking the production application.
function forbiddenStateInput() {
  const stateReads = [];
  return {
    sourceSha,
    tag,
    authorize: true,
    stateReads,
    get cacheDirectory() {
      stateReads.push("cacheDirectory");
      assert.fail("Unadmitted host accessed its credential/trust cache");
    },
    get directory() {
      stateReads.push("directory");
      assert.fail("Unadmitted host accessed retained release state");
    },
  };
}

test("host admission accepts the explicitly enabled exact tag workload without any credentials", () => {
  checkHost(identity, sourceSha, tag);
});

test.each(mismatches)(
  "a mismatched %s is rejected before credentials or retained state are read",
  async (_label, key, value) => {
    const environment = { ...identity, [key]: value };
    assert.throws(() => checkHost(environment, sourceSha, tag));
    const config = trackedConfiguration(environment);
    const input = forbiddenStateInput();
    await assert.rejects(
      Effect.runPromise(Effect.scoped(createApplication(input)).pipe(Effect.provide(config.layer))),
    );
    assert.deepEqual(input.stateReads, []);
    assert.ok(!config.reads.includes("GITHUB_TOKEN"));
    assert.ok(!config.reads.includes("ACTIONS_ID_TOKEN_REQUEST_TOKEN"));
    assert.ok(!config.reads.includes("ACTIONS_ID_TOKEN_REQUEST_URL"));
  },
);

test("missing workload configuration fails before credential lookup", async () => {
  const config = trackedConfiguration({});
  const input = forbiddenStateInput();
  await assert.rejects(
    Effect.runPromise(Effect.scoped(createApplication(input)).pipe(Effect.provide(config.layer))),
  );
  assert.deepEqual(input.stateReads, []);
  assert.ok(config.reads.includes("GITHUB_ACTIONS"));
  assert.ok(config.reads.every((name) => Object.hasOwn(identity, name)));
});

test("an admitted host without its Git credential fails before loading state or requesting OIDC", async () => {
  const config = trackedConfiguration(identity);
  const input = forbiddenStateInput();
  await assert.rejects(
    Effect.runPromise(Effect.scoped(createApplication(input)).pipe(Effect.provide(config.layer))),
  );
  assert.deepEqual(input.stateReads, []);
  assert.equal(config.reads.at(-1), "GITHUB_TOKEN");
  assert.ok(!config.reads.includes("ACTIONS_ID_TOKEN_REQUEST_TOKEN"));
});

test("host admission rejects malformed source commits and noncanonical run or repository identifiers", () => {
  for (const invalid of ["main", "a".repeat(39), "A".repeat(40), "a".repeat(40) + "\n"]) {
    assert.throws(() => checkHost({ ...identity, GITHUB_SHA: invalid }, invalid, tag));
  }
  for (const key of [
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ]) {
    for (const invalid of [undefined, "0", "01", "-1", "1.1", "1\n"]) {
      assert.throws(() => checkHost({ ...identity, [key]: invalid }, sourceSha, tag));
    }
  }
});
