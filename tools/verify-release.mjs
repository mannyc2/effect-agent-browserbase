import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackagePaths, checkTag, distTag, packageName, repositoryUrl } from "./package-release.mjs";

export function verifyRelease(directory, sha, tag, expectedDigest) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(expectedDigest, /^[a-f0-9]{64}$/);
  const receipt = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.name, packageName);
  assert.equal(receipt.repository, repositoryUrl);
  assert.equal(receipt.sourceSha, sha, "Artifact belongs to another source commit");
  checkTag(tag, receipt.version);
  assert.equal(receipt.distTag, distTag(receipt.version));
  assert.equal(receipt.filename, `effect-agent-platform-browserbase-${receipt.version}.tgz`);
  const tarball = join(directory, receipt.filename);
  assert.ok(lstatSync(tarball).isFile() && !lstatSync(tarball).isSymbolicLink());
  const bytes = readFileSync(tarball);
  assert.equal(bytes.length, receipt.bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, expectedDigest, "Tarball does not match the successful build output");
  assert.equal(digest, receipt.sha256);
  // Inspect without extracting or executing package contents. No dependency
  // installation or lifecycle scripts run in the OIDC-authorized publish job.
  const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
  const verbose = execFileSync("tar", ["-tvzf", tarball], { encoding: "utf8" }).trim().split("\n");
  assert.ok(verbose.every((line) => line.startsWith("-")), "Package must contain regular files, not links");
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  assert.equal(manifest.name, packageName);
  assert.equal(manifest.version, receipt.version);
  assert.equal(manifest.repository.url, repositoryUrl);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.files, ["dist"]);
  assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org/", tag: receipt.distTag });
  checkPackagePaths(list, manifest);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, sha, tag, digest] = process.argv.slice(2);
  assert.ok(directory && sha && tag && digest, "Usage: node tools/verify-release.mjs ARTIFACT SOURCE_SHA TAG SHA256");
  console.log(JSON.stringify(verifyRelease(directory, sha, tag, digest)));
}
