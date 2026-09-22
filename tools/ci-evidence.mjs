import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const common = ["tooling", "source-cleanliness"];
const library = ["boundary", "bootstrap", "format", "lint", "generic-typecheck", "typecheck", "generic-unit", "unit", "generic-build", "build", "exports", "purity", "install-browser", "install-media-tools", "packed-consumer", "release-identity", "package-dry-run", "review-check"];
export function requiredStages(profile) {
  assert.ok(["docs", "library", "full"].includes(profile), "Unknown acceptance profile");
  return [...common, ...(profile === "docs" ? ["docs-plan", "diff-check"] : library), ...(profile === "full" ? ["generic-native", "native", "upstream-check", "upstream-test", "upstream-build", "release-dry-run"] : [])];
}
export function parseStatuses(text) {
  const records = new Map();
  for (const line of text.trim().split("\n")) {
    const match = /^([a-z][a-z-]*) ([0-9]+)$/.exec(line);
    assert.ok(match && !records.has(match[1]), "Malformed or duplicate stage status");
    records.set(match[1], Number(match[2]));
  }
  return records;
}
export function verifyStages(directory, expectedProfile) {
  const profile = readFileSync(join(directory, "acceptance-profile.txt"), "utf8").trim();
  assert.equal(profile, expectedProfile, "Wrong acceptance profile");
  const stages = parseStatuses(readFileSync(join(directory, "statuses.txt"), "utf8"));
  assert.deepEqual([...stages.keys()].sort(), requiredStages(profile).sort(), "Missing or unexpected acceptance stages");
  assert.ok([...stages.values()].every((code) => code === 0), "An acceptance command failed");
  return profile;
}

/** Only complete success is compacted. Failed/cancelled runs retain installed declarations too. */
export function compactEvidence(directory) {
  const out = resolve(directory);
  const profile = readFileSync(join(out, "acceptance-profile.txt"), "utf8").trim();
  verifyStages(out, profile);
  const consumers = join(out, "consumers");
  if (!existsSync(consumers)) {
    assert.equal(profile, "docs", "Missing successful consumer workspaces");
    return;
  }
  assert.ok(lstatSync(consumers).isDirectory() && !lstatSync(consumers).isSymbolicLink(), "Expected real consumer workspaces");
  const destination = join(dirname(out), "completed-consumer-workspaces");
  const archive = join(out, "consumer-fixtures.tar.gz");
  const policy = join(out, "evidence-policy.json");
  assert.ok(!existsSync(destination) && !existsSync(archive) && !existsSync(policy), "Refusing to replace evidence");
  // Preserve fixtures, configs, lockfiles and their modes. Dependency installs are reproducible
  // inputs, not results; never follow symlinks. Tarballs/identity logs/video stay in OUT.
  execFileSync("tar", ["--exclude=node_modules", "--exclude=downloads", "-czf", archive, "-C", out, "consumers"], { timeout: 60_000 });
  writeFileSync(policy, JSON.stringify({
    schemaVersion: 1, profile, consumerFixtures: "consumer-fixtures.tar.gz",
    dependencyInstalls: "omitted after all checks passed; exact versions in retained locks",
    failurePolicy: "uncompacted consumer workspaces retained on failure or interruption",
  }, null, 2) + "\n", { flag: "wx" });
  // Move only after every fallible archive/metadata write. A failed preparation
  // must leave installed declarations in the uploaded diagnostic directory.
  mkdirSync(destination);
  renameSync(consumers, join(destination, "consumers"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, profile] = process.argv.slice(2);
  assert.ok(directory && ["compact", "verify"].includes(command), "Usage: node tools/ci-evidence.mjs compact|verify OUT [PROFILE]");
  if (command === "verify") verifyStages(directory, profile);
  else compactEvidence(directory);
}
