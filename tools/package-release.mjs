import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@effect-agent/platform-browserbase";
export const repositoryUrl = "git+https://github.com/mannyc2/effect-agent-browserbase.git";
export const packageDirectory = "packages/platform-browserbase";
export const publicSubpaths = [".", "./interactive-browser", "./types", "./tools", "./recordings", "./replays", "./downloads", "./capture"];
const number = "(?:0|[1-9][0-9]*)";
const versionPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-(alpha|beta|rc)\\.${number})?$`);

// Deliberately the project's supported release train, not a general SemVer parser.
export function distTag(version) {
  assert.equal(typeof version, "string", "A release version is required");
  const match = versionPattern.exec(version);
  assert.ok(match, "Expected x.y.z or x.y.z-(alpha|beta|rc).N");
  return match[1] ?? "latest";
}

export function checkTag(tag, version) {
  distTag(version);
  assert.equal(tag, `v${version}`, "Release tag must exactly match the package version");
}

export function publicationManifest(source, catalog, frameworkVersion) {
  assert.equal(source.name, packageName, "Only this repository's package may be released");
  assert.equal(source.private, undefined, "Cannot stage a private package");
  assert.equal(source.repository?.url, repositoryUrl, "Repository must match the npm OIDC identity");
  assert.equal(source.repository?.directory, packageDirectory);
  assert.equal(source.type, "module", "The supported distribution is ESM");
  assert.equal(source.license, "MIT");
  assert.deepEqual(Object.keys(source.exports).sort(), [...publicSubpaths].sort());
  distTag(frameworkVersion);
  const manifest = {};
  for (const key of ["name", "version", "description", "license", "repository", "type", "sideEffects", "engines", "dependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (source[key] !== undefined) manifest[key] = structuredClone(source[key]);
  }
  manifest.homepage = "https://github.com/mannyc2/effect-agent-browserbase#readme";
  manifest.bugs = { url: "https://github.com/mannyc2/effect-agent-browserbase/issues" };
  manifest.files = ["dist"];
  manifest.exports = {};
  for (const [key, value] of Object.entries(source.exports)) {
    assert.equal(typeof value, "string");
    assert.match(value, /^\.\/src\/[A-Za-z][A-Za-z0-9/]*\.ts$/, "Expected a source entry point");
    const stem = value.slice("./src/".length, -3);
    manifest.exports[key] = { types: `./dist/${stem}.d.mts`, default: `./dist/${stem}.mjs` };
  }
  for (const section of ["dependencies", "peerDependencies"]) {
    for (const [name, value] of Object.entries(manifest[section] ?? {})) {
      let resolved = value;
      if (value === "workspace:*") {
        assert.equal(name, "effect-agent", "Unexpected workspace dependency");
        resolved = frameworkVersion;
      } else if (value === "catalog:") {
        resolved = catalog[name];
      }
      assert.equal(typeof resolved, "string", `Unresolved dependency ${name}`);
      assert.match(resolved, /^[~^]?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/, `Non-registry dependency ${name}`);
      manifest[section][name] = resolved;
    }
  }
  manifest.publishConfig = { access: "public", registry: "https://registry.npmjs.org/", tag: distTag(source.version) };
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

export function packageRelease(tree, out, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, "Expected immutable source commit");
  const sourceDirectory = join(tree, packageDirectory);
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  const manifest = publicationManifest(readJson(join(sourceDirectory, "package.json")), readJson(join(tree, "package.json")).catalog, readJson(join(tree, "packages/effect-agent/package.json")).version);
  const files = distributionFiles(join(sourceDirectory, "dist"));
  checkPackagePaths(["package/package.json", "package/README.md", "package/LICENSE", ...files.map((path) => `package/dist/${path}`)], manifest);
  const stage = join(out, "packed-stage");
  assert.ok(!existsSync(stage), "Refusing an existing package stage");
  mkdirSync(stage, { recursive: true });
  cpSync(join(sourceDirectory, "dist"), join(stage, "dist"), { recursive: true });
  for (const name of ["README.md", "LICENSE"]) {
    assert.ok(lstatSync(join(sourceDirectory, name)).isFile() && !lstatSync(join(sourceDirectory, name)).isSymbolicLink());
    cpSync(join(sourceDirectory, name), join(stage, name));
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const filename = `effect-agent-platform-browserbase-${manifest.version}.tgz`;
  assert.ok(!existsSync(join(out, filename)), "Refusing an existing tarball");
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", resolve(out)], { cwd: stage, encoding: "utf8" }));
  assert.equal(packed.length, 1);
  assert.equal(packed[0].filename, filename);
  checkPackagePaths(packed[0].files.map(({ path }) => `package/${path}`), manifest);
  const bytes = readFileSync(join(out, filename));
  const receipt = { schemaVersion: 1, name: packageName, version: manifest.version, distTag: distTag(manifest.version), repository: repositoryUrl, sourceSha, filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(out, "release.json"), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tree, out, sha] = process.argv.slice(2);
  assert.ok(tree && out && sha, "Usage: node tools/package-release.mjs WORKSPACE OUT SOURCE_SHA");
  console.log(JSON.stringify(packageRelease(resolve(tree), resolve(out), sha)));
}
