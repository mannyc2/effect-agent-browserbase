import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseSet } from "./verify-release.mjs";

const execute = (args) => execFileSync("npm", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// Registry lookup is read-only. Only an explicit E404 means this immutable version
// is absent; a network/authentication error must not be mistaken for absence.
export function registryIntegrity(name, version, run = execute) {
  try {
    const value = JSON.parse(run(["view", `${name}@${version}`, "dist.integrity", "--json", "--registry", "https://registry.npmjs.org/"]));
    assert.equal(typeof value, "string", "Registry returned no exact-version integrity");
    assert.match(value, /^sha512-[A-Za-z0-9+/]{86}==$/, "Registry integrity is not SHA-512");
    return value;
  } catch (error) {
    const output = error?.stdout?.toString();
    if (output !== undefined) {
      let details;
      try { details = JSON.parse(output); } catch { /* Not a structured registry rejection. */ }
      if (details?.error?.code === "E404") return undefined;
    }
    throw error;
  }
}

/** The privileged caller must supply the successful build's immutable set digest. */
export function publishReleaseSet(directory, sha, tag, expectedDigest, { publish = false, run = execute } = {}) {
  const receipt = verifyReleaseSet(directory, sha, tag, expectedDigest);
  const outcomes = [];
  for (const entry of receipt.packages) {
    let state = "dry-run";
    if (publish) {
      const existing = registryIntegrity(entry.name, entry.version, run);
      if (existing !== undefined) {
        assert.equal(existing, entry.integrity, "Published version differs from the tested artifact; refuse recovery");
        state = "already-identical";
      } else state = "publish";
    }
    if (state !== "already-identical") {
      const args = ["publish", join(directory, entry.filename), "--access", "public", "--tag", receipt.distTag, "--registry", "https://registry.npmjs.org/", "--ignore-scripts"];
      args.push(...(publish ? ["--provenance"] : ["--dry-run", "--provenance=false"]));
      // Do not retry an uncertain publication. A deliberate rerun first checks
      // the registry's exact immutable integrity, including after a partial set.
      run(args);
      state = publish ? "published" : "dry-run";
    }
    const outcome = { sourceSha: sha, name: entry.name, version: entry.version, sha256: entry.sha256, state };
    outcomes.push(outcome);
    appendFileSync(join(directory, publish ? "publication.ndjson" : "publication-dry-run.ndjson"), JSON.stringify(outcome) + "\n");
  }
  return outcomes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, sha, tag, expectedDigest, mode] = process.argv.slice(2);
  assert.ok(directory && sha && tag && expectedDigest && ["--dry-run", "--publish"].includes(mode), "Usage: node tools/publish-release.mjs ARTIFACT SOURCE_SHA TAG RELEASE_SET_SHA256 --dry-run|--publish");
  if (mode === "--publish") {
    assert.equal(process.env.NPM_PUBLISH_ENABLED, "true", "Publishing requires explicit maintainer opt-in");
    assert.equal(process.env.GITHUB_ACTIONS, "true", "Publishing requires the protected GitHub OIDC job");
  }
  console.log(JSON.stringify(publishReleaseSet(resolve(directory), sha, tag, expectedDigest, { publish: mode === "--publish" })));
}
