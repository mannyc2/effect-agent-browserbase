import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

// An explicit release boundary, not discovery of arbitrary upstream workspaces.
export const repositoryUrl = "git+https://github.com/mannyc2/effect-agent-browserbase.git";
export const packages = Object.freeze([
  Object.freeze({ name: "effect-browserbase", directory: "packages/browserbase", stem: "effect-browserbase" }),
  Object.freeze({ name: "effect-agent-browserbase", directory: "packages/platform-browserbase", stem: "effect-agent-browserbase" }),
]);
const adapterExports = [".", "./adapter", "./tools"];
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(?:0|[1-9][0-9]*))?$/;
const regularVersion = /^[~^]?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/;

export function distTag(version) {
  assert.equal(typeof version, "string", "A release version is required");
  const match = versionPattern.exec(version);
  assert.ok(match && match[0] === version, "Expected x.y.z or x.y.z-(alpha|beta|rc).N");
  return match[1] ?? "latest";
}

export function checkTag(tag, version) {
  distTag(version);
  assert.equal(tag, `v${version}`, "Release tag must exactly match both package versions");
}

export function regularFile(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected a regular file: ${path}`);
  return stat;
}

export function readJson(path) {
  regularFile(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function packageFor(name) {
  const item = packages.find((entry) => entry.name === name);
  assert.ok(item, `Only this repository's canonical packages may be released: ${name}`);
  return item;
}

export function checkExports(exports, name, built = false) {
  assert.ok(exports && typeof exports === "object" && !Array.isArray(exports), "Expected explicit exports");
  const keys = Object.keys(exports);
  assert.ok(keys.includes("."), "A public root export is required");
  if (name === packages[1].name) assert.deepEqual(keys.sort(), [...adapterExports].sort(), "Adapter must expose only the canonical root, adapter and tools");
  const targets = new Set();
  for (const [key, value] of Object.entries(exports)) {
    assert.match(key, /^(?:\.|\.\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/, "Expected a deliberate public subpath");
    assert.ok(!/(?:^|[-/])(?:internal|legacy|compat)(?:$|[-/])/.test(key), "Private or compatibility exports are forbidden");
    const target = built ? value?.default : value;
    assert.equal(typeof target, "string", "Expected a source entry point");
    assert.match(target, built ? /^\.\/dist\/[A-Za-z][A-Za-z0-9]*\.mjs$/ : /^\.\/src\/[A-Za-z][A-Za-z0-9]*\.ts$/, "Expected a flat public source entry point");
    assert.equal(posix.normalize(target), target.slice(2), "Non-canonical export path");
    assert.ok(!targets.has(target), "Parallel aliases for the same public module are forbidden");
    targets.add(target);
    if (built) {
      assert.deepEqual(Object.keys(value).sort(), ["default", "types"]);
      assert.equal(value.types, target.slice(0, -4) + ".d.mts", "Declaration does not match runtime export");
    }
  }
}

export function checkDependencyBoundary(manifest, { built = false, genericVersion, frameworkVersion } = {}) {
  const item = packageFor(manifest.name);
  const generic = item === packages[0];
  assert.equal(manifest.optionalDependencies, undefined, "Optional regular dependencies are not part of this release graph");
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), generic ? [] : [packages[0].name, "effect-agent"].sort(), "Unexpected regular dependency edge");
  assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), generic ? ["effect", "playwright-core"] : ["effect"], "Unexpected peer dependency edge");
  assert.match(manifest.peerDependencies.effect, regularVersion);
  if (generic) {
    assert.match(manifest.peerDependencies["playwright-core"], versionPattern, "Playwright peer must be exact");
    assert.deepEqual(manifest.peerDependenciesMeta, { "playwright-core": { optional: true } });
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        assert.ok(name !== "effect-agent" && !name.startsWith("@effect-agent/"), "Generic package cannot depend on the framework or its testing package");
        assert.notEqual(name, "@browserbasehq/sdk", "A runtime SDK requires a reviewed dependency change");
      }
    }
  } else {
    assert.ok(manifest.peerDependenciesMeta === undefined || Object.keys(manifest.peerDependenciesMeta).length === 0);
    assert.equal(manifest.dependencies[packages[0].name], built ? genericVersion : "workspace:*");
    assert.equal(manifest.dependencies["effect-agent"], built ? frameworkVersion : "workspace:*");
  }
}

export function checkManifest(manifest, options = {}) {
  const item = packageFor(manifest.name);
  assert.equal(manifest.private, undefined, "Cannot stage a private package");
  assert.equal(manifest.repository?.url, repositoryUrl, "Repository must match npm OIDC identity");
  assert.equal(manifest.repository?.directory, item.directory);
  assert.equal(manifest.type, "module", "The distribution is ESM");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.sideEffects, []);
  distTag(manifest.version);
  checkExports(manifest.exports, manifest.name, options.built);
  checkDependencyBoundary(manifest, options);
  return item;
}

export function readPackageSet(tree) {
  const sources = packages.map((item) => readJson(join(tree, item.directory, "package.json")));
  for (let index = 0; index < packages.length; index++) {
    assert.equal(sources[index].name, packages[index].name, "Package directory/name mismatch");
    checkManifest(sources[index]);
  }
  assert.equal(sources[0].version, sources[1].version, "Canonical packages must use one coordinated version");
  assert.equal(sources[0].peerDependencies.effect, sources[1].peerDependencies.effect, "Effect peer contracts must agree");
  return sources;
}
