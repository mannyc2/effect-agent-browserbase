import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertDocsPlan, makePlan } from "../ci-plan.mjs";

test("an older PR gets the base's CI tools and validates the exact merged candidate", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browserbase-ci-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, "README.md"), "# Initial\n"); commit();
  git("checkout", "-qb", "feature");
  writeFileSync(join(root, "README.md"), "# Documentation change\n");
  const feature = commit();
  assert.equal(existsSync(join(root, "tools/ci-plan.mjs")), false);
  git("checkout", "-q", "main");
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/ci-plan.mjs"), "// newly added CI tool\n");
  const base = commit();
  git("merge", "--no-ff", "-m", "combined candidate", "feature");
  const merged = git("rev-parse", "HEAD");
  assert.notEqual(merged, feature);
  assert.equal(existsSync(join(root, "tools/ci-plan.mjs")), true);
  const plan = makePlan(root, { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base });
  assert.equal(plan.sourceSha, merged);
  assert.equal(plan.profile, "docs");
  assert.deepEqual(plan.changes.map((change) => change.path), ["README.md"]);
  assertDocsPlan(root, plan);
});

test("checkout uses the merge candidate unless the release caller pins an exact source", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("ref: ${{ inputs.source_sha || github.sha }}"));
  assert.doesNotMatch(workflow, /ref: .*pull_request\.head\.sha/);
  assert.match(workflow, /persist-credentials: false/);
});
