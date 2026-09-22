import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sha = /^[a-f0-9]{40}$/;
const integration = new Set(["upstream.patch", ".node-version", "package.json", "tools/bootstrap.sh", "tools/pinned-toolchain.sh"]);
const rootDocs = new Set(["README.md", "CONTRIBUTING.md", "AGENTS.md", "SECURITY.md", "CHANGELOG.md"]);
const documentation = (path) => rootDocs.has(path) || /^docs\/.*\.md$/.test(path);
const owned = (path) => /^(?:packages\/(?:browser|browserbase|agent-browser)\/|tools\/|\.github\/|docs\/)/.test(path);
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

/** NUL records and --no-renames keep both sides of a rename in the decision. */
export function parseChanges(raw) {
  if (raw === "") return [];
  assert.ok(raw.endsWith("\0"), "Truncated Git diff");
  const fields = raw.slice(0, -1).split("\0");
  assert.equal(fields.length % 2, 0, "Malformed Git diff");
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) {
    const header = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([ADMT])$/.exec(fields[i]);
    assert.ok(header && fields[i + 1], "Unexpected Git diff record");
    changes.push({ path: fields[i + 1], beforeMode: header[1], afterMode: header[2], status: header[3] });
  }
  return changes;
}

export function classifyChanges(changes) {
  if (changes.length === 0) return { profile: "full", reason: "empty-or-unavailable-diff" };
  for (const { path, beforeMode, afterMode } of changes) {
    if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes("..") || path.startsWith("/"))
      return { profile: "full", reason: "unclassified-path" };
    if (![beforeMode, afterMode].every((mode) => ["000000", "100644", "100755"].includes(mode)))
      return { profile: "full", reason: "non-regular-file-change" };
    if (integration.has(path) || !owned(path) && !rootDocs.has(path))
      return { profile: "full", reason: "integration-boundary-change" };
  }
  if (changes.every(({ path, beforeMode, afterMode }) => documentation(path) &&
      [beforeMode, afterMode].every((mode) => ["000000", "100644"].includes(mode))))
    return { profile: "docs", reason: "documentation-only" };
  return { profile: "library", reason: "owned-library-or-tooling-change" };
}

export function planForEvent({ event, forceFull = false, requested = "full", changes, diffAvailable = true }) {
  if (forceFull || event === "schedule") return { profile: "full", reason: "release-or-scheduled-integration" };
  if (event === "workflow_dispatch") {
    assert.ok(["full", "library"].includes(requested), "Unknown manual acceptance profile");
    return { profile: requested, reason: "explicit-manual-profile" };
  }
  if (!["pull_request", "push", "merge_group"].includes(event) || !diffAvailable)
    return { profile: "full", reason: "empty-or-unavailable-diff" };
  return classifyChanges(changes);
}

export function readChanges(cwd, base, head, event) {
  assert.match(base, sha, "Missing immutable diff base");
  assert.match(head, sha, "Missing immutable source");
  assert.notEqual(base, "0".repeat(40), "Initial push has no diff base");
  const comparisonBase = event === "pull_request" ? git(["merge-base", base, head], cwd).trim() : base;
  assert.match(comparisonBase, sha);
  const changes = parseChanges(git(["diff", "--raw", "--no-renames", "--abbrev=40", "-z", comparisonBase, head, "--"], cwd));
  return { base: comparisonBase, changes };
}

export function makePlan(cwd, env = process.env) {
  const head = git(["rev-parse", "HEAD"], cwd).trim();
  assert.match(head, sha);
  const event = env.GITHUB_EVENT_NAME ?? "local";
  let diff, diffError;
  try { diff = readChanges(cwd, env.CI_BASE_SHA ?? "", head, event); }
  catch { diffError = "Git comparison unavailable; running full acceptance"; }
  const decision = planForEvent({ event, forceFull: env.CI_FORCE_FULL === "true", requested: env.CI_REQUESTED_PROFILE ?? "full", changes: diff?.changes ?? [], diffAvailable: diff !== undefined });
  return { schemaVersion: 1, sourceSha: head, event, ...decision, baseSha: diff?.base ?? null, changes: diff?.changes ?? [], ...(diffError ? { diagnostic: diffError } : {}) };
}

/** A saved docs decision cannot authorize another commit or an edited path list. */
export function assertDocsPlan(cwd, plan) {
  assert.equal(plan.profile, "docs");
  assert.equal(git(["rev-parse", "HEAD"], cwd).trim(), plan.sourceSha, "Plan belongs to another source");
  const actual = readChanges(cwd, plan.baseSha, plan.sourceSha, "push");
  assert.deepEqual(actual.changes, plan.changes, "Change list differs from Git");
  assert.equal(classifyChanges(actual.changes).profile, "docs", "Not a docs-only change");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  assert.ok(path && ["write", "assert-docs"].includes(command), "Usage: node tools/ci-plan.mjs write|assert-docs PLAN.json");
  if (command === "assert-docs") assertDocsPlan(process.cwd(), JSON.parse(readFileSync(path, "utf8")));
  else {
    const plan = makePlan(process.cwd());
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(path, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `profile=${plan.profile}\n`);
    console.log(JSON.stringify(plan));
  }
}
