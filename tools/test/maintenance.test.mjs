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

test("acceptance records every stage it did not execute, and why", () => {
  const acceptance = read("tools/run-acceptance.sh");

  // A stage that was skipped or already satisfied still owes statuses.txt an
  // entry. Silence there would read as a pass in the retained record.
  assert.ok(acceptance.includes('printf \'%s %s\\n\' "$name" "$state" | tee -a "$OUT/statuses.txt"'));
  assert.ok(acceptance.includes("note install-browser satisfied"));
  assert.ok(acceptance.includes("note install-media-tools satisfied"));
  // A prerequisite that did not pass must stop dependent stages rather than let
  // them fail against a missing artifact and read as separate defects.
  assert.ok(acceptance.includes("run_after build packed-consumer"));
  assert.ok(acceptance.includes("note release-identity skipped"));
  assert.ok(acceptance.includes("note package-dry-run skipped"));
  // A satisfied prerequisite is not a failure, but it is also not a pass.
  assert.match(acceptance, /case "\$\{CODE\[\$dep\]:-missing\}" in\s*\n\s*0 \| satisfied\) ;;/);
  assert.ok(acceptance.includes("FAILED=1"), "a skipped stage must not silently succeed");
});

test("the task-cache transfer speeds the gate up without shrinking or faking it", () => {
  const acceptance = read("tools/run-acceptance.sh");
  const ci = read(".github/workflows/ci.yml");

  // The whole point is that nothing was removed to buy the time back.
  assert.ok(acceptance.includes("--concurrency-limit 1 ready"));
  assert.doesNotMatch(acceptance, /ready\s+--exclude|-t\s|--testNamePattern|--bail/);
  // bun install owns node_modules, so a cache placed there before bootstrap is
  // simply deleted. Seeding must come after the bootstrap stage.
  assert.ok(
    acceptance.indexOf("run bootstrap") < acceptance.indexOf('cp -a "$SEED/." "$TASK_CACHE/"'),
    "the cache must be seeded after bootstrap, not before",
  );
  // A lock file belongs to the run that created it, never to a restored copy.
  assert.equal((acceptance.match(/-name '\*\.lock' -delete/g) ?? []).length, 2);
  // The record must distinguish a replayed result from a fresh execution.
  assert.ok(acceptance.includes('"$OUT/task-cache.txt"'));
  assert.ok(acceptance.includes("no seed"));
  // An unset variable must leave a completely cold, self-contained run.
  assert.ok(acceptance.includes('SEED="${BROWSERBASE_TASK_CACHE:-}"'));

  // runner.temp does not resolve in job env; it is exported by the first step.
  assert.ok(ci.includes("printf 'BROWSERBASE_TASK_CACHE=%s/browserbase-task-cache\\n' \"$RUNNER_TEMP\""));
  // Saving an empty export would shadow a usable older entry under the same prefix.
  assert.ok(ci.includes("steps.exported.outputs.present == 'true'"));
  // The restore key must change when the workspace identity does.
  for (const input of ["tools/bootstrap.sh", "upstream.patch", ".node-version", ".bun-version"]) {
    assert.ok(ci.includes(input), `restore key must cover ${input}`);
  }
  // A cache is not a credential and grants no new write scope.
  assert.doesNotMatch(ci, /permissions:\s*\n\s*contents: write/);
});

test("the local gate is a fast loop, not a second acceptance program", () => {
  const verify = read("tools/verify.sh");

  // It must not install system packages or claim any release authority.
  assert.doesNotMatch(verify, /sudo|apt-get|--with-deps|npm publish|BROWSERBASE_API_KEY/);
  // It must not mint an evidence bundle that could be mistaken for acceptance.
  assert.doesNotMatch(verify, /SHA256SUMS|release\.json|candidate\.tar\.gz|review\.patch/);
  // It must say what it does not cover, and point at the real program.
  assert.ok(verify.includes("run-acceptance.sh is the fixed evidence program"));
  assert.ok(verify.includes("Not covered here"));
  // It reads the same pins as everything else rather than restating them.
  assert.ok(verify.includes('"v$(cat "$ROOT/.node-version")"'));
  assert.ok(verify.includes('"$(cat "$ROOT/.bun-version")"'));
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
  assert.doesNotMatch(publisher, /npm (?:ci|install)|bun install|secrets\.|contents: write/);
  assert.ok(workflow.includes("default: false"));
});
