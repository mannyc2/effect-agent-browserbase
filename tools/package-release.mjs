import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, distTag, packages, readJson, readPackageSet, regularFile, repositoryUrl } from "./packages.mjs";

export function publicationManifest(source, catalog, workspaceVersions) {
  checkManifest(source);
  const manifest = {};
  for (const key of ["name", "version", "description", "license", "repository", "type", "sideEffects", "engines", "dependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (source[key] !== undefined) manifest[key] = structuredClone(source[key]);
  }
  manifest.homepage = "https://github.com/mannyc2/effect-agent-browserbase#readme";
  manifest.bugs = { url: "https://github.com/mannyc2/effect-agent-browserbase/issues" };
  manifest.files = ["dist"];
  manifest.exports = {};
  for (const [key, value] of Object.entries(source.exports)) {
    const stem = value.slice("./src/".length, -3);
    manifest.exports[key] = { types: `./dist/${stem}.d.mts`, default: `./dist/${stem}.mjs` };
  }
  for (const section of ["dependencies", "peerDependencies"]) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      const resolved = value === "workspace:*" ? workspaceVersions[name] : value === "catalog:" ? catalog[name] : value;
      assert.equal(typeof resolved, "string", `Unresolved dependency ${name}`);
      assert.match(resolved, /^[~^]?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/, `Non-registry dependency ${name}`);
      manifest[section][name] = resolved;
    }
  }
  manifest.publishConfig = { access: "public", registry: "https://registry.npmjs.org/", tag: distTag(source.version) };
  checkManifest(manifest, { built: true, browserVersion: workspaceVersions[packages[0].name], frameworkVersion: workspaceVersions["effect-agent"] });
  return manifest;
}

export function distributionFiles(directory, prefix = "") {
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), "dist must be a real directory");
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    assert.match(name, /^[A-Za-z0-9_.-]+$/, "Unsafe distribution filename");
    const path = join(directory, name);
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), "Symlinks cannot enter the distribution");
    if (info.isDirectory()) result.push(...distributionFiles(path, `${prefix}${name}/`));
    else {
      assert.ok(info.isFile(), "Only regular files may be published");
      assert.match(name, /(?:\.mjs|\.d\.mts)(?:\.map)?$/, "Unexpected build output");
      result.push(`${prefix}${name}`);
    }
  }
  return result;
}

export function checkPackagePaths(paths, manifest) {
  const allowed = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);
  assert.equal(new Set(paths).size, paths.length, "Duplicate package member");
  for (const path of paths) {
    assert.equal(posix.normalize(path), path, "Non-canonical package path");
    assert.ok(!path.includes("\\") && !path.includes("\n") && !path.startsWith("/"), "Unsafe package path");
    assert.ok(allowed.has(path) || /^package\/dist\/[A-Za-z0-9_./-]+(?:\.mjs|\.d\.mts)(?:\.map)?$/.test(path), `Unexpected published file: ${path}`);
  }
  for (const path of allowed) assert.ok(paths.includes(path), `Missing ${path}`);
  for (const entry of Object.values(manifest.exports)) {
    for (const path of Object.values(entry)) assert.ok(paths.includes(`package/${path.slice(2)}`), `Missing built export: ${path}`);
  }
}

export const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);

export function releaseSetDigest(directory) {
  const path = join(directory, "release-set.json");
  regularFile(path);
  return digest(readFileSync(path));
}

/** All immutable tarballs are written before the single source-bound receipt. */
export function packageReleaseSet(tree, out, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, "Expected immutable source commit");
  const sources = readPackageSet(tree);
  const catalog = readJson(join(tree, "package.json")).catalog;
  const frameworkVersion = readJson(join(tree, "packages/effect-agent/package.json")).version;
  distTag(frameworkVersion);
  const version = sources[0].version;
  const workspaceVersions = { ...Object.fromEntries(sources.map((source) => [source.name, source.version])), "effect-agent": frameworkVersion };
  const manifests = sources.map((source) => publicationManifest(source, catalog, workspaceVersions));
  const stageRoot = join(out, "packed-stage");
  assert.ok(!existsSync(stageRoot) && !existsSync(join(out, "release-set.json")) && !existsSync(join(out, "release.json")), "Refusing an existing package stage or receipt");
  // Validate all members before npm packs anything. Failure leaves no success receipt.
  for (const [index, item] of packages.entries()) {
    const directory = join(tree, item.directory);
    const files = distributionFiles(join(directory, "dist"));
    checkPackagePaths(["package/package.json", "package/README.md", "package/LICENSE", ...files.map((path) => `package/dist/${path}`)], manifests[index]);
    regularFile(join(directory, "README.md"));
    regularFile(join(directory, "LICENSE"));
    assert.ok(!existsSync(join(out, `${item.stem}-${version}.tgz`)), "Refusing an existing tarball");
  }
  mkdirSync(stageRoot, { recursive: true });
  const receipts = [];
  for (const [index, item] of packages.entries()) {
    const directory = join(tree, item.directory);
    const stage = join(stageRoot, item.directory.split("/").at(-1));
    mkdirSync(stage);
    cpSync(join(directory, "dist"), join(stage, "dist"), { recursive: true });
    for (const name of ["README.md", "LICENSE"]) cpSync(join(directory, name), join(stage, name));
    writeFileSync(join(stage, "package.json"), JSON.stringify(manifests[index], null, 2) + "\n");
    const filename = `${item.stem}-${version}.tgz`;
    const packed = JSON.parse(execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", resolve(out)], { cwd: stage, encoding: "utf8", timeout: 60_000 }));
    assert.equal(packed.length, 1);
    assert.equal(packed[0].filename, filename);
    checkPackagePaths(packed[0].files.map(({ path }) => `package/${path}`), manifests[index]);
    const bytes = readFileSync(join(out, filename));
    const integrity = `sha512-${digest(bytes, "sha512", "base64")}`;
    assert.equal(packed[0].integrity, integrity);
    receipts.push({ name: item.name, version, directory: item.directory, filename, bytes: bytes.length, sha256: digest(bytes), integrity });
  }
  const receipt = { schemaVersion: 2, repository: repositoryUrl, sourceSha, version, frameworkVersion, distTag: distTag(version), packages: receipts };
  writeFileSync(join(out, "release-set.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tree, out, sha] = process.argv.slice(2);
  assert.ok(tree && out && sha, "Usage: node tools/package-release.mjs WORKSPACE OUT SOURCE_SHA");
  const receipt = packageReleaseSet(resolve(tree), resolve(out), sha);
  console.log(JSON.stringify({ ...receipt, receiptSha256: releaseSetDigest(out) }));
}
