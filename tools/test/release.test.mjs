import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkPackagePaths, checkTag, distTag, distributionFiles, packageName, packageRelease, publicationManifest, repositoryUrl } from "../package-release.mjs";
import { verifyRelease } from "../verify-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = JSON.parse(readFileSync(join(root, "packages/platform-browserbase/package.json"), "utf8"));
const version = "0.1.0-beta.102";
const sha = "1234567890abcdef1234567890abcdef12345678";
const manifest = () => publicationManifest(source, { effect: "4.0.0-rc.115" }, version);
const paths = (value) => ["package/package.json", "package/README.md", "package/LICENSE", ...Object.values(value.exports).flatMap((entry) => Object.values(entry).map((path) => `package/${path.slice(2)}`))];
const temporary = (t) => {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test("publication is restricted to the owned package and its actual repository", () => {
  assert.equal(manifest().name, packageName);
  assert.equal(manifest().repository.url, repositoryUrl);
  assert.throws(() => publicationManifest({ ...source, name: "effect-agent" }, {}, version), /Only this repository/);
  assert.throws(() => publicationManifest({ ...source, repository: { ...source.repository, url: "git+https://github.com/danieljvdm/effect-agent.git" } }, {}, version), /OIDC identity/);
});

test("distribution strips source, tests, development dependencies and lifecycle scripts", () => {
  const result = manifest();
  assert.deepEqual(result.files, ["dist"]);
  assert.equal(result.scripts, undefined);
  assert.equal(result.devDependencies, undefined);
  assert.equal(result.dependencies["effect-agent"], version);
  assert.equal(result.peerDependencies.effect, "^4.0.0-rc.115");
  assert.equal(result.peerDependencies["playwright-core"], "1.63.0");
  assert.deepEqual(result.peerDependenciesMeta["playwright-core"], { optional: true });
  assert.deepEqual(result.exports["."], { types: "./dist/index.d.mts", default: "./dist/index.mjs" });
  assert.equal(Object.keys(result.exports).length, 9);
  assert.deepEqual(result.exports["./page-control"], { types: "./dist/PageControl.d.mts", default: "./dist/PageControl.mjs" });
});

test("normalization never mutates the source manifest", () => {
  const original = JSON.stringify(source);
  const out = manifest();
  out.dependencies["effect-agent"] = "wrong";
  out.repository.url = "wrong";
  assert.equal(JSON.stringify(source), original);
});

test("private packages, unresolved catalog values and extra workspace edges fail closed", () => {
  assert.throws(() => publicationManifest({ ...source, private: true }, {}, version), /private/);
  assert.throws(() => publicationManifest({ ...source, dependencies: { effect: "catalog:" } }, {}, version), /Unresolved/);
  assert.throws(() => publicationManifest({ ...source, dependencies: { "@effect-agent/testing": "workspace:*" } }, {}, version), /Unexpected workspace/);
  assert.throws(() => publicationManifest({ ...source, dependencies: { effect: "file:../effect" } }, {}, version), /Non-registry/);
});

test("export drift, path traversal and missing built declarations are rejected", () => {
  assert.throws(() => publicationManifest({ ...source, exports: { ...source.exports, "./internal": "./src/internal.ts" } }, {}, version));
  assert.throws(() => publicationManifest({ ...source, exports: { ...source.exports, ".": "./src/../secret.ts" } }, {}, version), /source entry/);
  const out = manifest();
  const members = paths(out);
  checkPackagePaths(members, out);
  assert.throws(() => checkPackagePaths(members.filter((path) => !path.endsWith("index.d.mts")), out), /Missing built export/);
  assert.throws(() => checkPackagePaths([...members, "package/src/secret.ts"], out), /Unexpected published/);
  assert.throws(() => checkPackagePaths([...members, "package/dist/../../secret.mjs"], out), /Non-canonical/);
  assert.throws(() => checkPackagePaths([...members, members[0]], out), /Duplicate/);
});

test("release tags match the manifest and prereleases never default to latest", () => {
  for (const channel of ["alpha", "beta", "rc"]) {
    assert.equal(distTag(`0.1.0-${channel}.1`), channel);
    checkTag(`v0.1.0-${channel}.1`, `0.1.0-${channel}.1`);
  }
  assert.equal(distTag("1.0.0"), "latest");
  for (const value of ["01.0.0", "1.0.0-beta.01", "1.0.0-next.1", "$(touch bad)", "1.0.0\nother"]) {
    assert.throws(() => distTag(value), /Expected/);
  }
  assert.throws(() => checkTag("v0.1.0", version), /exactly match/);
  assert.throws(() => checkTag("main", version), /exactly match/);
});

test("build output cannot include environment files or symlinked host files", (t) => {
  const dir = temporary(t);
  writeFileSync(join(dir, "index.mjs"), "export {};\n");
  assert.deepEqual(distributionFiles(dir), ["index.mjs"]);
  writeFileSync(join(dir, ".env"), "NOT_A_SECRET=test\n");
  assert.throws(() => distributionFiles(dir), /Unexpected build output/);
  rmSync(join(dir, ".env"));
  symlinkSync(join(dir, "index.mjs"), join(dir, "outside.mjs"));
  assert.throws(() => distributionFiles(dir), /Symlinks/);
});

test("actual offline npm pack is verified; corrupted bytes, source identity and stale stages fail", (t) => {
  const dir = temporary(t);
  const tree = join(dir, "tree");
  const pkg = join(tree, "packages/platform-browserbase");
  const out = join(dir, "output");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(tree, "packages/effect-agent"), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(tree, "package.json"), JSON.stringify({ catalog: { effect: "4.0.0-rc.115" } }));
  writeFileSync(join(tree, "packages/effect-agent/package.json"), JSON.stringify({ version }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify(source));
  writeFileSync(join(pkg, "README.md"), "# Offline package fixture\n");
  cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
  for (const path of paths(manifest()).filter((path) => path.startsWith("package/dist/"))) {
    const target = join(pkg, path.slice("package/".length));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export {};\n");
  }
  // This is a packaging fixture, not a substitute framework/native acceptance.
  const receipt = packageRelease(tree, out, sha);
  assert.equal(receipt.distTag, "beta");
  assert.equal(verifyRelease(out, sha, `v${version}`, receipt.sha256).sha256, receipt.sha256);
  assert.throws(() => verifyRelease(out, "f".repeat(40), `v${version}`, receipt.sha256), /another source/);
  assert.throws(() => verifyRelease(out, sha, `v${version}`, "0".repeat(64)), /successful build/);
  assert.throws(() => packageRelease(tree, out, sha), /existing package stage/);
  const tarball = join(out, receipt.filename);
  const bytes = readFileSync(tarball);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(tarball, bytes);
  assert.notEqual(createHash("sha256").update(bytes).digest("hex"), receipt.sha256);
  assert.throws(() => verifyRelease(out, sha, `v${version}`, receipt.sha256), /successful build/);
});
