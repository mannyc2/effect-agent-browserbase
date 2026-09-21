import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseSet } from "./verify-release.mjs";

const execute = (args) => execFileSync("npm", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const nativePublication = "Live publication requires the native ts-release CLI and compiled tools/release/src/application.js host and its retained ts-release journal; this helper only performs --dry-run";

/** Acceptance checks only: live publication belongs to the native ts-release application. */
export function publishReleaseSet(directory, sha, tag, expectedDigest, { publish = false, run = execute } = {}) {
  // Reject the retired API before verification can execute even a local command.
  assert.equal(publish, false, nativePublication);
  const receipt = verifyReleaseSet(directory, sha, tag, expectedDigest);
  const outcomes = [];
  for (const entry of receipt.packages) {
    run(["publish", join(directory, entry.filename), "--access", "public", "--tag", receipt.distTag,
      "--registry", "https://registry.npmjs.org/", "--ignore-scripts", "--dry-run", "--provenance=false"]);
    const outcome = { sourceSha: sha, name: entry.name, version: entry.version, sha256: entry.sha256, state: "dry-run" };
    outcomes.push(outcome);
    appendFileSync(join(directory, "publication-dry-run.ndjson"), JSON.stringify(outcome) + "\n");
  }
  return outcomes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, sha, tag, expectedDigest, mode] = process.argv.slice(2);
  assert.notEqual(mode, "--publish", nativePublication);
  assert.ok(directory && sha && tag && expectedDigest && mode === "--dry-run", "Usage: node tools/publish-release.mjs ARTIFACT SOURCE_SHA TAG RELEASE_SET_SHA256 --dry-run");
  console.log(JSON.stringify(publishReleaseSet(resolve(directory), sha, tag, expectedDigest)));
}
