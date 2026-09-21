import assert from "node:assert/strict";
import { test } from "node:test";

import { FULL_EVIDENCE_STEP, selectReusableRun } from "../release-reuse.mjs";

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

/** `profile` decides whether the acceptance job ran, or skipped, the full-evidence step. */
const passed = (profile = "full") => [
  {
    name: "Unpaid acceptance",
    conclusion: "success",
    steps: [
      { name: "Execute recorded acceptance profile", conclusion: "success" },
      { name: FULL_EVIDENCE_STEP, conclusion: profile === "full" ? "success" : "skipped" },
    ],
  },
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

test("a successful focused run is not release evidence, so an older full run or a build is used", () => {
  // The ordinary case: merging a package change runs the library profile on main, under the
  // same artifact name a full run uses.
  for (const profile of ["library", "docs"]) {
    assert.equal(
      selectReusableRun({ sha, runs: [run(1)], jobs: { 1: passed(profile) }, artifacts: { 1: retained(1) } }),
      undefined,
      profile,
    );
  }
  assert.deepEqual(
    selectReusableRun({
      sha,
      runs: [run(1, { event: "workflow_dispatch" }), run(2)],
      jobs: { 1: passed("full"), 2: passed("library") },
      artifacts: { 1: retained(1), 2: retained(2) },
    }),
    { runId: 1, acceptanceArtifactId: 10, toolingArtifactId: 11 },
  );
  // A jobs listing without step detail proves nothing about the profile.
  const withoutSteps = passed().map(({ steps: _steps, ...job }) => job);

  assert.equal(
    selectReusableRun({ sha, runs: [run(1)], jobs: { 1: withoutSteps }, artifacts: { 1: retained(1) } }),
    undefined,
  );
});

test("a run missing a passed job or a retained artifact falls back to an older one or to a build", () => {
  const noTooling = passed().slice(0, 1);
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
