import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { assertDocsPlan, classifyChanges, makePlan, parseChanges, planForEvent, readChanges } from "../ci-plan.mjs";
import { compactEvidence, parseStatuses, requiredStages, verifyStages } from "../ci-evidence.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const text = (file) => readFileSync(file, "utf8");
const change = (path, beforeMode = "100644", afterMode = "100644") => ({ path, beforeMode, afterMode, status: "M" });
const write = (file, content, mode) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content, mode ? { mode } : {}); };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const temporaries = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "browserbase-ci-test-")); temporaries.push(dir); return dir; };
after(() => { for (const dir of temporaries) rmSync(dir, { recursive: true, force: true }); });
const commit = (cwd) => { git(cwd, "add", "."); git(cwd, "commit", "-qm", "fixture"); return git(cwd, "rev-parse", "HEAD"); };
function repository() {
  const dir = temporary();
  git(dir, "init", "-q"); git(dir, "config", "user.email", "fixture@example.invalid"); git(dir, "config", "user.name", "Fixture");
  write(join(dir, "README.md"), "# Fixture\n");
  commit(dir);
  return dir;
}

for (const path of ["README.md", "CONTRIBUTING.md", "docs/history/example.md", "docs/HOSTED.md"]) {
  test(`plain documentation selects only documented checks: ${path}`, () => assert.equal(classifyChanges([change(path)]).profile, "docs"));
}
for (const path of ["packages/browser/src/Browser.ts", "packages/browserbase/src/Browser.ts", "packages/browserbase/README.md", "packages/agent-browser/test/native/agent.test.ts", "tools/ci-plan.mjs", ".github/workflows/ci.yml", "docs/media/demo.mp4"]) {
  test(`owned change retains all five artifact consumers: ${path}`, () => assert.equal(classifyChanges([change(path)]).profile, "library"));
}
for (const path of ["test/integration/ownership.test.ts", "test/unknown.ts", "test/vite.config.ts", "upstream.patch", ".node-version", "package.json", "tools/bootstrap.sh", "tools/pinned-toolchain.sh", "new-runtime/index.ts", ".gitignore", "docs/../hidden.md", "docs/line\nbreak.md"]) {
  test(`integration or unknown paths require full validation: ${JSON.stringify(path)}`, () => assert.equal(classifyChanges([change(path)]).profile, "full"));
}
test("empty diffs, symlinks and submodules cannot become docs passes", () => {
  assert.equal(classifyChanges([]).profile, "full");
  for (const mode of ["120000", "160000"]) assert.equal(classifyChanges([change("README.md", "100644", mode)]).profile, "full");
  assert.equal(classifyChanges([change("docs/script.md", "100644", "100755")]).profile, "library");
});
test("NUL Git records retain deletions and reject truncated or rename-shaped input", () => {
  const record = `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0packages/browserbase/src/Old.ts\0`;
  assert.deepEqual(parseChanges(record), [{ path: "packages/browserbase/src/Old.ts", beforeMode: "100644", afterMode: "000000", status: "D" }]);
  assert.throws(() => parseChanges(record.slice(0, -1)), /Truncated/);
  assert.throws(() => parseChanges(record.replace(" D\0", " R100\0")), /Unexpected/);
});
test("release/default-full, schedule, manual choice and missing base are explicit", () => {
  const docs = [change("README.md")];
  for (const event of ["pull_request", "push", "merge_group"]) {
    assert.equal(planForEvent({ event, changes: docs }).profile, "docs");
    assert.equal(planForEvent({ event, changes: docs, forceFull: true }).profile, "full");
    assert.equal(planForEvent({ event, changes: docs, diffAvailable: false }).profile, "full");
  }
  assert.equal(planForEvent({ event: "schedule", changes: docs }).profile, "full");
  assert.equal(planForEvent({ event: "workflow_dispatch", changes: docs }).profile, "full");
  assert.equal(planForEvent({ event: "workflow_dispatch", requested: "library", changes: docs }).profile, "library");
  assert.throws(() => planForEvent({ event: "workflow_dispatch", requested: "docs" }), /Unknown/);
  assert.equal(planForEvent({ event: "unknown", changes: docs }).profile, "full");
});
test("real Git comparison sees a source-to-doc rename and forged docs plans fail", () => {
  const dir = repository();
  write(join(dir, "packages/browserbase/src/old.ts"), "export {};\n");
  const base = commit(dir);
  git(dir, "mv", "packages/browserbase/src/old.ts", "old.md");
  const head = commit(dir);
  const diff = readChanges(dir, base, head, "pull_request");
  assert.equal(diff.changes.length, 2);
  assert.equal(classifyChanges(diff.changes).profile, "full");
  const plan = makePlan(dir, { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base });
  assert.throws(() => assertDocsPlan(dir, { ...plan, profile: "docs", changes: [change("README.md")] }), /Change list/);
  assert.equal(makePlan(dir, { GITHUB_EVENT_NAME: "push", CI_BASE_SHA: "0".repeat(40) }).profile, "full");
});
test("large Git diffs cannot hide a source change behind the API filename limit", () => {
  const dir = repository(), base = git(dir, "rev-parse", "HEAD");
  for (let i = 0; i < 310; i++) write(join(dir, "docs", `${i}.md`), "# Fixture\n");
  write(join(dir, "packages/browserbase/src/changed.ts"), "export {};\n");
  const head = commit(dir), diff = readChanges(dir, base, head, "pull_request");
  assert.equal(diff.changes.length, 311);
  assert.equal(classifyChanges(diff.changes).profile, "library");
});
test("docs plans are source-bound and recomputed from Git, not trusted filename input", () => {
  const dir = repository(), base = git(dir, "rev-parse", "HEAD");
  write(join(dir, "README.md"), "# Changed\n"); commit(dir);
  const plan = makePlan(dir, { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base });
  assertDocsPlan(dir, plan);
  write(join(dir, "README.md"), "# Changed again\n"); commit(dir);
  assert.throws(() => assertDocsPlan(dir, plan), /another source/);
});

function evidence(profile, alteration = (rows) => rows) {
  const work = temporary(), out = join(work, "results");
  mkdirSync(out);
  write(join(out, "acceptance-profile.txt"), profile + "\n");
  write(join(out, "statuses.txt"), alteration(requiredStages(profile).map((name) => `${name} 0`)).join("\n") + "\n");
  return { work, out };
}
test("full evidence requires every stage and raw zero; a library receipt is not full", () => {
  const { out } = evidence("full"); verifyStages(out, "full");
  assert.throws(() => verifyStages(evidence("library").out, "full"), /Wrong/);
  assert.throws(() => verifyStages(evidence("full", (rows) => rows.filter((row) => !row.startsWith("upstream-test "))).out, "full"), /Missing/);
  assert.throws(() => verifyStages(evidence("full", (rows) => rows.map((row) => row === "packed-consumer 0" ? "packed-consumer 1" : row)).out, "full"), /failed/);
  assert.throws(() => parseStatuses("unit 0\nunit 0\n"), /duplicate/);
  assert.throws(() => parseStatuses(""), /Malformed/);
});
test("successful evidence retains exact fixtures/locks and leaves dependency installs outside upload", () => {
  const { out, work } = evidence("library");
  write(join(out, "consumers/agent/tsconfig.json"), '{"compilerOptions":{"skipLibCheck":false}}\n');
  write(join(out, "consumers/agent/bun.lock"), "pinned fixture lock\n");
  write(join(out, "consumers/agent/.fixture-proof"), "hidden fixture\n");
  write(join(out, "consumers/agent/node_modules/effect-agent/dist/test.d.mts"), "export {};\n");
  write(join(out, "consumer-agent-declarations.log"), "raw zero\n");
  compactEvidence(out);
  assert.equal(existsSync(join(out, "consumers")), false);
  assert.ok(existsSync(join(work, "completed-consumer-workspaces/consumers/agent/node_modules/effect-agent/dist/test.d.mts")));
  const members = execFileSync("tar", ["-tzf", join(out, "consumer-fixtures.tar.gz")], { encoding: "utf8" });
  assert.match(members, /bun\.lock/); assert.match(members, /\.fixture-proof/); assert.doesNotMatch(members, /node_modules/);
  assert.equal(execFileSync("tar", ["-xOf", join(out, "consumer-fixtures.tar.gz"), "consumers/agent/tsconfig.json"], { encoding: "utf8" }), '{"compilerOptions":{"skipLibCheck":false}}\n');
  assert.equal(text(join(out, "consumer-agent-declarations.log")), "raw zero\n");
});
test("failed or partial evidence is never compacted; symlink roots are refused", () => {
  const { out } = evidence("library", (rows) => rows.map((row) => row === "packed-consumer 0" ? "packed-consumer 1" : row));
  write(join(out, "consumers/agent/node_modules/broken.d.mts"), "retained failure\n");
  assert.throws(() => compactEvidence(out), /failed/);
  assert.equal(text(join(out, "consumers/agent/node_modules/broken.d.mts")), "retained failure\n");
  assert.equal(existsSync(join(out, "consumer-fixtures.tar.gz")), false);
  const other = evidence("library");
  symlinkSync(temporary(), join(other.out, "consumers"));
  assert.throws(() => compactEvidence(other.out), /real consumer/);
});

/** Test the actual shell control flow; external tools are deterministic local substitutes.
 * This is not a browser run, a package pass, or proof of the pinned runtime installation. */
function runnerFixture() {
  const dir = repository(), work = temporary(), bin = join(work, "bin");
  mkdirSync(bin);
  for (const name of ["run-acceptance.sh", "ci-plan.mjs", "ci-evidence.mjs"]) {
    mkdirSync(join(dir, "tools"), { recursive: true }); cpSync(join(root, "tools", name), join(dir, "tools", name));
  }
  write(join(dir, ".node-version"), process.versions.node + "\n");
  write(join(dir, "tools/test/fixture.test.mjs"), 'import { after, test } from "node:test"; test("substitute", () => {});\n');
  write(join(dir, "tools/run-boundary-suite.sh"), '#!/bin/sh\necho "fixture boundary"\n');
  write(join(dir, "packages/browser/index.ts"), "export {};\n");
  write(join(dir, "test/integration/fixture.test.ts"), "export {};\n");
  write(join(dir, "packages/browserbase/index.ts"), "export {};\n");
  write(join(dir, "packages/agent-browser/index.ts"), "export {};\n");
  write(join(bin, "bun"), '#!/bin/sh\necho "1.4.2"\n', 0o755);
  // An extension-less script takes its module type from the nearest package.json. Without
  // this, a TMPDIR inside a "type": "module" checkout parses the CommonJS stub as ESM.
  write(join(bin, "package.json"), '{ "type": "commonjs" }\n');
  write(join(bin, "timeout"), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
// Never install OS packages in this orchestration test.
if (args[1] === 'bash' && args[2] === '-lc') process.exit(0);
const r = spawnSync(args[1], args.slice(2), { stdio: 'inherit', timeout: 20000 });
process.exit(r.status ?? 1);
`, 0o755);
  const vp = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const a=process.argv.slice(2), pkg=process.cwd().endsWith('/browserbase')?'generic':process.cwd().endsWith('/browser')?'browser':'agent';
appendFileSync(process.env.CI_FIXTURE_COMMANDS, JSON.stringify({pkg,args:a})+'\\n');
const task=a[0]==='fmt'?'format':a.includes('--config')?pkg+'-native':'other';
process.exit(task===process.env.CI_FIXTURE_FAIL?7:0);
`;
  write(join(dir, "tools/vp-fixture.mjs"), vp);
  write(join(dir, "tools/bootstrap.sh"), `#!/usr/bin/env bash
set -eu
TREE="$1/tree"
mkdir -p "$TREE/node_modules/.bin" "$TREE/.changeset" "$TREE/docs/guide"
cp -r packages test "$TREE/"
cp tools/vp-fixture.mjs "$TREE/node_modules/.bin/vp"
chmod +x "$TREE/node_modules/.bin/vp"
printf 'node_modules/\\n' > "$TREE/.gitignore"
printf '{}\\n' > "$TREE/package.json"
printf 'lock\\n' > "$TREE/bun.lock"
printf 'change\\n' > "$TREE/.changeset/browserbase-interactive.md"
printf '{}\\n' > "$TREE/.changeset/config.json"
printf '# Guide\\n' > "$TREE/docs/guide/browser.md"
git -C "$TREE" init -q
git -C "$TREE" config user.name Fixture
git -C "$TREE" config user.email fixture@example.invalid
git -C "$TREE" add .
git -C "$TREE" commit -qm fixture
`);
  write(join(dir, "tools/packed-consumer.sh"), `#!/usr/bin/env bash
set -eu
mkdir -p "$2/consumers/agent/node_modules"
printf '{"version":"0.1.0-beta.102"}\\n' > "$2/release-set.json"
printf 'fixture installed declarations\\n' > "$2/consumers/agent/node_modules/fixture.d.mts"
printf '{"strict":true,"skipLibCheck":false}\\n' > "$2/consumers/agent/tsconfig.json"
`);
  write(join(dir, "tools/package-release.mjs"), 'export const releaseSetDigest = () => "a".repeat(64);\n');
  for (const file of ["verify-release.mjs", "publish-release.mjs"]) write(join(dir, "tools", file), "// substituted external packaging command\n");
  const base = commit(dir);
  write(join(dir, "README.md"), "# Docs change\n"); commit(dir);
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH, BROWSERBASE_WORK_ROOT: work, CI_FIXTURE_COMMANDS: join(work, "commands.ndjson"), GITHUB_STEP_SUMMARY: join(work, "summary.md") };
  delete env.NODE_TEST_CONTEXT;
  write(join(work, "ci-plan.json"), JSON.stringify(makePlan(dir, { GITHUB_EVENT_NAME: "pull_request", CI_BASE_SHA: base })));
  return { dir, work, env };
}
for (const profile of ["docs", "library", "full"]) {
  test(`actual runner executes the exact ${profile} graph and retains its label`, () => {
    const { dir, work, env } = runnerFixture();
    const result = spawnSync("bash", ["tools/run-acceptance.sh", profile], { cwd: dir, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const out = join(work, "results"); verifyStages(out, profile);
    const stages = parseStatuses(text(join(out, "statuses.txt")));
    assert.equal(stages.has("upstream-test"), profile === "full");
    if (profile === "full") assert.equal(text(join(out, "upstream-tests.txt")), "reachable\n");
    assert.equal(stages.has("generic-native"), profile === "full");
    assert.equal(stages.has("browser-native"), profile === "full");
    assert.equal(stages.has("integration-unit"), profile !== "docs");
    assert.equal(stages.has("packed-consumer"), profile !== "docs");
    assert.equal(text(join(out, "acceptance-exit.txt")), "0\n");
    assert.match(text(join(out, "timings.tsv")), /^stage\texit_code\tduration_ms\n/);
    assert.ok(existsSync(join(out, "SHA256SUMS")));
  });
}
test("a library formatting failure stops before native installation and keeps partial evidence", () => {
  const { dir, work, env } = runnerFixture();
  const result = spawnSync("bash", ["tools/run-acceptance.sh", "library"], { cwd: dir, env: { ...env, CI_FIXTURE_FAIL: "format" }, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const out = join(work, "results"), stages = parseStatuses(text(join(out, "statuses.txt")));
  assert.equal(stages.get("format"), 7);
  assert.equal(stages.has("install-browser"), false);
  assert.equal(stages.has("packed-consumer"), false);
  assert.ok(existsSync(join(out, "candidate.tar.gz")));
  assert.equal(text(join(out, "acceptance-exit.txt")), "1\n");
});
test("full acceptance preserves an early native failure while independent checks continue", () => {
  const { dir, work, env } = runnerFixture();
  const result = spawnSync("bash", ["tools/run-acceptance.sh", "full"], { cwd: dir, env: { ...env, CI_FIXTURE_FAIL: "generic-native" }, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const out = join(work, "results"), stages = parseStatuses(text(join(out, "statuses.txt")));
  assert.equal(stages.get("generic-native"), 7);
  assert.equal(stages.get("upstream-test"), 0);
  assert.equal(stages.get("release-dry-run"), 0);
  assert.ok(existsSync(join(out, "consumers/agent/node_modules/fixture.d.mts")));
  assert.equal(existsSync(join(out, "consumer-fixtures.tar.gz")), false);
});
test("workflow retains one required check, stacked PRs, no privileged context, and full-only outputs", () => {
  const workflow = text(join(root, ".github/workflows/ci.yml"));
  assert.match(workflow, /pull_request:\n  push:/);
  assert.match(workflow, /name: Unpaid acceptance/);
  assert.match(workflow, /full_acceptance:[\s\S]*?default: true/);
  assert.match(workflow, /steps\.plan\.outputs\.profile == 'full'/);
  assert.match(workflow, /verifyStages\(directory, 'full'\)/);
  assert.match(workflow, /steps\.release\.outcome == 'success' && steps\.artifact/);
  assert.doesNotMatch(workflow, /pull_request_target|id-token: write|contents: write|secrets\.|paths-ignore:/);
});
