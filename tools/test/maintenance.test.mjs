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
  assert.ok(!bootstrap.includes("checkpoints/"));
  assert.equal((bootstrap.match(/--frozen-lockfile/g) ?? []).length, 2);
  assert.ok(bootstrap.includes('apply --check "$ROOT/upstream.patch"'));
  assert.ok(!read("upstream.patch").includes("diff --git a/packages/platform-browserbase/"));
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
  assert.doesNotMatch(acceptance, /EFFECT_AGENT_BROWSERBASE_LIVE=1|hosted-acceptance\.sh/);
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
