import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("all maintained shell entry points parse without executing any commands", () => {
  for (const name of readdirSync(join(root, "tools")).filter((name) => name.endsWith(".sh"))) {
    execFileSync("bash", ["-n", join(root, "tools", name)]);
  }
});

test("bootstrap uses a single current patch and frozen installs, not historical inputs", () => {
  const bootstrap = read("tools/bootstrap.sh");
  assert.equal((bootstrap.match(/--frozen-lockfile/g) ?? []).length, 2);
  assert.ok(bootstrap.includes('apply --check "$ROOT/upstream.patch"'));
  // The patch integrates the packages into upstream; their source arrives by copy, never by diff.
  for (const owned of ["browser", "browserbase", "agent-browser"]) {
    assert.ok(!read("upstream.patch").includes(`diff --git a/packages/${owned}/`));
  }
  assert.ok(!existsSync(join(root, "tools/canonicalize-candidate.sh")));
  assert.ok(!existsSync(join(root, "tools/fetch-inputs.py")));
  assert.equal(JSON.parse(read("package.json")).private, true);
});

test("ordinary acceptance has no live publisher, hosted opt-in or write-enabled workflow", () => {
  const ci = read(".github/workflows/ci.yml");
  const jobEnvironment = ci.slice(ci.indexOf("\n    env:\n"), ci.indexOf("\n    steps:\n"));
  assert.doesNotMatch(jobEnvironment, /runner\./, "Runner context is available in steps, not job env");
  assert.ok(ci.includes("pull_request:") && ci.includes("push:") && ci.includes("merge_group:"));
  assert.doesNotMatch(ci, /pull_request_target|id-token: write|contents: write|secrets\.|git push|agent\/browserbase-completion/);
  const acceptance = read("tools/run-acceptance.sh");
  for (const line of acceptance.split("\n").filter((line) => /npm publish|release:publish/.test(line))) {
    assert.ok(line.includes("--dry-run"), `Unsafe ordinary acceptance command: ${line}`);
  }
  assert.doesNotMatch(acceptance, /EFFECT_AGENT_BROWSERBASE_LIVE=1|hosted-run\.sh/);
});

test("OIDC is isolated to the opt-in publisher, which installs no dependencies", () => {
  const workflow = read(".github/workflows/publish.yml");
  const publisher = workflow.slice(workflow.indexOf("\n  publish:\n"));
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
  assert.ok(publisher.includes("id-token: write"));
  assert.ok(publisher.includes("NPM_PUBLISH_ENABLED == 'true'"));
  assert.ok(publisher.includes("environment: npm"));
  assert.ok(publisher.includes("--ignore-scripts"));
  assert.ok(publisher.includes("artifact-ids:"));
  assert.doesNotMatch(publisher, /npm (?:ci|install)|bun install|secrets\.|npm publish/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.ok(publisher.includes("contents: write"));
  assert.ok(publisher.includes("release_tooling_sha256"));
  assert.ok(publisher.includes("sha256sum --check --strict"));
  assert.ok(publisher.includes("node node_modules/.bin/ts-release src/application.js release-input.json"));
  assert.ok(publisher.includes("publication-report.json"));
  assert.ok(workflow.includes("default: false"));
});

test("a release reuses only verified full evidence of the exact commit, else builds", () => {
  const workflow = read(".github/workflows/publish.yml");
  const reuse = workflow.slice(workflow.indexOf("\n  reuse:\n"), workflow.indexOf("\n  build:\n"));
  const build = workflow.slice(workflow.indexOf("\n  build:\n"), workflow.indexOf("\n  publish:\n"));

  // The reuse job reads Actions and nothing else; OIDC and write access stay on the publisher.
  assert.ok(reuse.includes("actions: read"));
  assert.doesNotMatch(reuse, /id-token|contents: write|secrets\./);
  assert.ok(reuse.includes("release-reuse.mjs find"));
  assert.ok(reuse.includes("release-reuse.mjs verify"));
  // The full gate is skipped only when verified evidence was found.
  assert.ok(build.includes("needs.reuse.outputs.reused != 'true'"));
  assert.ok(build.includes("uses: ./.github/workflows/ci.yml"));
  assert.match(workflow, /reused: \$\{\{ steps\.verify\.outcome == 'success'/);
  // Reuse can only ever shorten a release. A failed lookup, download or verification leaves
  // `reused` false, and a failed reuse job still lets the full gate run.
  for (const id of ["find", "acceptance", "tooling", "verify"])
    assert.match(reuse, new RegExp(`id: ${id}\\n(?:\\s+if: [^\\n]+\\n)?\\s+continue-on-error: true`), id);
  assert.match(build, /if: \$\{\{ !cancelled\(\) && needs\.resolve\.result == 'success' &&/);
});

test("the step that marks a run as full release evidence exists and is full-only", async () => {
  const { FULL_EVIDENCE_STEP } = await import("../release-reuse.mjs");
  const ci = read(".github/workflows/ci.yml");
  const step = ci.slice(ci.indexOf(`- name: ${FULL_EVIDENCE_STEP}\n`));

  // release-reuse.mjs selects runs by this step's success; renaming it here must fail there.
  assert.ok(step.startsWith(`- name: ${FULL_EVIDENCE_STEP}\n`));
  assert.match(step.slice(0, 200), /if: \$\{\{ success\(\) && steps\.plan\.outputs\.profile == 'full' \}\}/);
});

test("full acceptance runs upstream's check and build whole, and tests only what the patch reaches", () => {
  const acceptance = read("tools/run-acceptance.sh");
  const upstream = acceptance.slice(acceptance.indexOf('UPSTREAM_TESTS="${BROWSERBASE_UPSTREAM_TESTS'), acceptance.indexOf("run release-dry-run"));

  assert.ok(upstream.includes("reachable) TEST_ARGS=(--parallel --concurrency-limit 1 --fail-if-no-match -F effect-browser -F effect-browserbase -F effect-agent-browser -F @effect-agent/testing test)"));
  // The canary spelling is upstream's own root script, recursion included, not a filter.
  assert.ok(upstream.includes("all) TEST_ARGS=(test)"));
  assert.ok(upstream.includes("run upstream-check timeout 900s ./node_modules/.bin/vp run -v check"));
  assert.ok(upstream.includes("run upstream-build timeout 900s ./node_modules/.bin/vp run -v build"));
  assert.ok(upstream.includes('"$OUT/upstream-tests.txt"'));
  // Only the scheduled drift canary pays for upstream's unrelated suites.
  const ci = read(".github/workflows/ci.yml");

  assert.match(ci, /BROWSERBASE_UPSTREAM_TESTS: \$\{\{ github\.event_name == 'schedule' && 'all' \|\| 'reachable' \}\}/);
});

test("the upstream task cache is seeded only after every stage with external effects", () => {
  const acceptance = read("tools/run-acceptance.sh");
  const seed = acceptance.indexOf('cp -a "$SEED/." "$TASK_CACHE/"');

  assert.ok(seed > acceptance.indexOf("run packed-consumer"));
  assert.ok(seed > acceptance.indexOf("run package-dry-run"));
  assert.ok(seed > acceptance.lastIndexOf("install_native"));
  assert.ok(seed < acceptance.indexOf("run upstream-check"));
  assert.ok(acceptance.indexOf('cp -a "$TASK_CACHE/." "$SEED/"') > acceptance.indexOf("run release-dry-run"));
  const ci = read(".github/workflows/ci.yml");

  assert.ok(ci.includes("if: ${{ steps.plan.outputs.profile == 'full' }}"));
  assert.ok(ci.includes("steps.exported.outputs.present == 'true'"));
  // The nightly canary discards the restored cache before acceptance, and still saves afterwards.
  const cold = ci.indexOf("- name: Keep the scheduled gate cold");

  assert.ok(cold > ci.indexOf("- name: Restore upstream task cache"));
  assert.ok(cold < ci.indexOf("- name: Execute recorded acceptance profile"));
  assert.match(ci.slice(cold, cold + 200), /if: \$\{\{ github\.event_name == 'schedule' \}\}/);
});
