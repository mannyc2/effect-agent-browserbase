import assert from "node:assert/strict";
import { test } from "node:test";

import { selectReusableRun } from "../release-reuse.mjs";

const sha = "a".repeat(40);

const run = (id, overrides = {}) => ({
  id,
  run_attempt: 1,
  head_sha: sha,
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  event: "push",
  created_at: `2026-09-2${id}T00:00:00Z`,
  ...overrides,
});

const passed = () => [
  { name: "Unpaid acceptance", conclusion: "success" },
  { name: "Native release recovery", conclusion: "success" },
];

const retained = (id, attempt = 1) => [
  { id: id * 10, name: `browserbase-acceptance-${id}-${attempt}`, expired: false },
  { id: id * 10 + 1, name: `browserbase-release-tooling-${id}-${attempt}`, expired: false },
];

test("the newest fully suitable main run for the exact commit is selected", () => {
  const selected = selectReusableRun({
    sha,
    runs: [run(1), run(3, { event: "schedule" }), run(2, { event: "workflow_dispatch" })],
    jobs: { 1: passed(), 2: passed(), 3: passed() },
    artifacts: { 1: retained(1), 2: retained(2), 3: retained(3) },
  });

  assert.deepEqual(selected, { runId: 3, acceptanceArtifactId: 30, toolingArtifactId: 31 });
});

test("pull-request, other-commit, other-branch and failed runs are never reused", () => {
  for (const overrides of [
    { event: "pull_request" },
    { event: "merge_group" },
    { head_sha: "b".repeat(40) },
    { head_branch: "feature" },
    { conclusion: "failure" },
    { status: "in_progress" },
  ]) {
    assert.equal(
      selectReusableRun({ sha, runs: [run(1, overrides)], jobs: { 1: passed() }, artifacts: { 1: retained(1) } }),
      undefined,
      JSON.stringify(overrides),
    );
  }
});

test("a run missing a passed job or a retained artifact falls back to an older one or to a build", () => {
  const noTooling = [{ name: "Unpaid acceptance", conclusion: "success" }];
  const expired = retained(2).map((artifact) => ({ ...artifact, expired: true }));

  assert.deepEqual(
    selectReusableRun({
      sha,
      runs: [run(1), run(2), run(3)],
      jobs: { 1: passed(), 2: passed(), 3: noTooling },
      artifacts: { 1: retained(1), 2: expired, 3: retained(3) },
    }),
    { runId: 1, acceptanceArtifactId: 10, toolingArtifactId: 11 },
  );
  assert.equal(selectReusableRun({ sha, runs: [], jobs: {}, artifacts: {} }), undefined);
  // An artifact from another attempt of the same run is not this attempt's evidence.
  assert.equal(
    selectReusableRun({ sha, runs: [run(1, { run_attempt: 2 })], jobs: { 1: passed() }, artifacts: { 1: retained(1, 1) } }),
    undefined,
  );
});
