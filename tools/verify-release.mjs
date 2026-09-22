import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, checkTag, distTag, packages, regularFile, repositoryUrl } from "./packages.mjs";
import { checkPackagePaths, digest, releaseSetDigest } from "./package-release.mjs";

const tar = (args) => execFileSync("tar", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
const exactKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "Unexpected receipt fields");

/** Validate the trusted build's entire set; never extract or execute artifact code. */
export function verifyReleaseSet(directory, sourceSha, tag, expectedDigest) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.match(expectedDigest, /^[a-f0-9]{64}$/);
  assert.equal(releaseSetDigest(directory), expectedDigest, "Release set does not match the successful build output");
  const receipt = JSON.parse(readFileSync(join(directory, "release-set.json"), "utf8"));
  exactKeys(receipt, ["schemaVersion", "repository", "sourceSha", "version", "frameworkVersion", "distTag", "packages"]);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.repository, repositoryUrl);
  assert.equal(receipt.sourceSha, sourceSha, "Artifact belongs to another source commit");
  checkTag(tag, receipt.version);
  distTag(receipt.frameworkVersion);
  assert.equal(receipt.distTag, distTag(receipt.version));
  assert.ok(Array.isArray(receipt.packages));
  assert.deepEqual(receipt.packages.map((entry) => entry.name), packages.map((item) => item.name), "Expected the complete dependency-ordered three-package set");
  let effectPeer;
  for (const [index, entry] of receipt.packages.entries()) {
    const item = packages[index];
    exactKeys(entry, ["name", "version", "directory", "filename", "bytes", "sha256", "integrity"]);
    assert.equal(entry.version, receipt.version);
    assert.equal(entry.directory, item.directory);
    assert.equal(entry.filename, `${item.stem}-${receipt.version}.tgz`);
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 128 * 1024 * 1024, "Invalid artifact size");
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    const path = join(directory, entry.filename);
    assert.equal(regularFile(path).size, entry.bytes, "Tarball size mismatch");
    const bytes = readFileSync(path);
    assert.equal(digest(bytes), entry.sha256, "Tarball does not match the successful build output");
    assert.equal(`sha512-${digest(bytes, "sha512", "base64")}`, entry.integrity, "Tarball integrity mismatch");
    const paths = tar(["-tzf", path]).trim().split("\n");
    const modes = tar(["-tvzf", path]).trim().split("\n");
    assert.ok(modes.every((line) => line.startsWith("-")), "Package must contain only regular files, not links");
    const manifest = JSON.parse(tar(["-xOf", path, "package/package.json"]));
    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, receipt.version);
    checkManifest(manifest, { built: true, browserVersion: receipt.version, frameworkVersion: receipt.frameworkVersion });
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.overrides, undefined);
    assert.equal(manifest.resolutions, undefined);
    assert.equal(manifest.bin, undefined);
    assert.deepEqual(manifest.files, ["dist"]);
    assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org/", tag: receipt.distTag });
    if (effectPeer === undefined) effectPeer = manifest.peerDependencies.effect;
    else assert.equal(manifest.peerDependencies.effect, effectPeer, "Effect contracts differ within release set");
    checkPackagePaths(paths, manifest);
    if (index < 2) {
      // Check every emitted declaration, not just public barrels. The real consumer
      // additionally typechecks this graph with both optional/native/framework absent.
      const declarations = paths.filter((name) => name.endsWith(".d.mts"));
      const text = tar(["-xOf", path, ...declarations]);
      assert.doesNotMatch(text, /["'](?:effect-agent(?:-browser(?:base)?)?|@effect-agent\/[^/'"]+|playwright(?:-core)?|@browserbasehq\/sdk)(?:[/'"])/, "Generic declaration imports a forbidden dependency");
      if (index === 0) assert.doesNotMatch(text, /["']effect-browserbase(?:[/'"])/, "Neutral declaration imports Browserbase");
    } else {
      const declarations = paths.filter((name) => name.endsWith(".d.mts"));
      const text = tar(["-xOf", path, ...declarations]);
      assert.doesNotMatch(text, /["'](?:effect-browserbase|effect-agent-browserbase|@browserbasehq\/sdk)(?:[/'"])/, "Agent declaration imports Browserbase");
    }
  }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, sha, tag, expectedDigest] = process.argv.slice(2);
  assert.ok(directory && sha && tag && expectedDigest, "Usage: node tools/verify-release.mjs ARTIFACT SOURCE_SHA TAG RELEASE_SET_SHA256");
  console.log(JSON.stringify(verifyReleaseSet(directory, sha, tag, expectedDigest)));
}
