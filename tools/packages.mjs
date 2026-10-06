import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

// An explicit release boundary, not discovery of arbitrary upstream workspaces.
export const repositoryUrl = "git+https://github.com/mannyc2/effect-agent-browserbase.git";

export const packages = Object.freeze([
  Object.freeze({ name: "effect-browser", directory: "packages/browser", stem: "effect-browser" }),
  Object.freeze({
    name: "effect-browserbase",
    directory: "packages/browserbase",
    stem: "effect-browserbase",
  }),
  Object.freeze({
    name: "effect-agent-browser",
    directory: "packages/agent-browser",
    stem: "effect-agent-browser",
  }),
]);

const [browser, provider, adapter] = packages;

// These are separate installations, including provider-free browser and Agent consumers.
export const consumerProfiles = Object.freeze([
  "resources",
  "browser",
  "generic",
  "agent",
  "agent-hosted",
]);

export function consumerPackageSet(profile) {
  assert.ok(consumerProfiles.includes(profile), `Unknown consumer profile ${profile}`);
  if (profile === "browser") return [browser];
  if (profile === "agent") return [browser, adapter];

  return profile === "agent-hosted" ? [...packages] : [browser, provider];
}

const adapterExports = [".", "./adapter", "./browser-use", "./tools"];

const versionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(alpha|beta|rc)\.(?:0|[1-9][0-9]*))?$/;

const regularVersion =
  /^[~^]?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[A-Za-z0-9.-]+)?$/;

export function distTag(version) {
  assert.equal(typeof version, "string", "A release version is required");
  const match = versionPattern.exec(version);

  assert.ok(match && match[0] === version, "Expected x.y.z or x.y.z-(alpha|beta|rc).N");

  return match[1] ?? "latest";
}

export function checkTag(tag, version) {
  distTag(version);
  assert.equal(tag, `v${version}`, "Release tag must exactly match all package versions");
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
  assert.ok(
    exports && typeof exports === "object" && !Array.isArray(exports),
    "Expected explicit exports",
  );
  const keys = Object.keys(exports);

  assert.ok(keys.includes("."), "A public root export is required");
  if (name === adapter.name)
    assert.deepEqual(
      keys.sort(),
      [...adapterExports].sort(),
      "Adapter must expose only the canonical root, adapter, browser-use and tools",
    );
  const targets = new Set();

  for (const [key, value] of Object.entries(exports)) {
    assert.match(
      key,
      /^(?:\.|\.\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/,
      "Expected a deliberate public subpath",
    );
    assert.ok(
      !/(?:^|[-/])(?:internal|legacy|compat)(?:$|[-/])/.test(key),
      "Private or compatibility exports are forbidden",
    );
    const target = built ? value?.default : value;

    assert.equal(typeof target, "string", "Expected a source entry point");
    assert.match(
      target,
      built ? /^\.\/dist\/[A-Za-z][A-Za-z0-9]*\.mjs$/ : /^\.\/src\/[A-Za-z][A-Za-z0-9]*\.ts$/,
      "Expected a flat public source entry point",
    );
    assert.equal(posix.normalize(target), target.slice(2), "Non-canonical export path");
    assert.ok(!targets.has(target), "Parallel aliases for the same public module are forbidden");
    targets.add(target);
    if (built) {
      assert.deepEqual(Object.keys(value).sort(), ["default", "types"]);
      assert.equal(
        value.types,
        target.slice(0, -4) + ".d.mts",
        "Declaration does not match runtime export",
      );
    }
  }
}

export function checkDependencyBoundary(
  manifest,
  { built = false, browserVersion, frameworkVersion } = {},
) {
  const item = packageFor(manifest.name);
  const generic = item !== adapter;

  const hostPeers =
    item === browser ? [] : item === provider ? [browser.name] : [browser.name, "effect-agent"];

  assert.equal(
    manifest.optionalDependencies,
    undefined,
    "Optional regular dependencies are not part of this release graph",
  );
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    "Unexpected regular dependency edge",
  );
  assert.deepEqual(
    Object.keys(manifest.peerDependencies ?? {}).sort(),
    ["effect", ...(item === browser ? ["playwright-core"] : hostPeers)].sort(),
    "Unexpected peer dependency edge",
  );
  assert.match(manifest.peerDependencies.effect, regularVersion);
  // `effect-browserbase` and `effect-agent-browser` import `effect/unstable/*`, which Effect
  // versions outside semver (rc.118 removed every such path), and the three packages share one
  // Effect peer. A range, even from a stable release, admits versions that cannot load them, so
  // every package peers on the version it was tested with until those imports are gone.
  assert.doesNotMatch(manifest.peerDependencies.effect, /^[~^]/, "The Effect peer must be exact");
  if (!built)
    assert.equal(
      manifest.peerDependencies.effect,
      manifest.devDependencies?.effect,
      "The Effect peer must be the version it is developed against",
    );
  if (item === browser) {
    assert.match(
      manifest.peerDependencies["playwright-core"],
      versionPattern,
      "Playwright peer must be exact",
    );
    assert.deepEqual(manifest.peerDependenciesMeta, { "playwright-core": { optional: true } });
  } else {
    assert.ok(
      manifest.peerDependenciesMeta === undefined ||
        Object.keys(manifest.peerDependenciesMeta).length === 0,
    );
  }
  for (const name of hostPeers) {
    if (built) {
      assert.match(
        manifest.peerDependencies[name],
        versionPattern,
        `Host peer ${name} must be exact`,
      );
      assert.equal(
        manifest.peerDependencies[name],
        name === browser.name ? browserVersion : frameworkVersion,
        `Host peer ${name} does not match the qualified workspace`,
      );
    } else if (name === browser.name) {
      assert.equal(
        manifest.peerDependencies[name],
        "workspace:*",
        `Host peer ${name} must use the workspace`,
      );
      assert.equal(
        manifest.devDependencies?.[name],
        "workspace:*",
        `Host peer ${name} requires a workspace development dependency`,
      );
    } else {
      // The framework comes from npm: the release qualifies the exact version it was tested with.
      assert.match(
        manifest.peerDependencies[name],
        versionPattern,
        `Host peer ${name} must be exact`,
      );
      assert.equal(
        manifest.devDependencies?.[name],
        manifest.peerDependencies[name],
        `Host peer ${name} must be developed against the version it requires`,
      );
    }
  }
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      assert.notEqual(
        name,
        "@browserbasehq/sdk",
        "A runtime SDK requires a reviewed dependency change",
      );
      assert.notEqual(
        name,
        "effect-agent-browserbase",
        "The retired adapter is not part of this graph",
      );
      if (generic)
        assert.ok(
          name !== "effect-agent" && name !== adapter.name && !name.startsWith("@effect-agent/"),
          "Generic package cannot depend on the framework or its testing package",
        );
      if (item === browser)
        assert.notEqual(name, provider.name, "Neutral browser cannot depend on Browserbase");
    }
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
    assert.equal(
      sources[index].version,
      sources[0].version,
      "Canonical packages must use one coordinated version",
    );
    assert.equal(
      sources[index].peerDependencies.effect,
      sources[0].peerDependencies.effect,
      "Effect peer contracts must agree",
    );
  }

  return sources;
}

/**
 * One version of every registry dependency across the root and package manifests. There is no
 * catalog: each manifest names its versions, so an update that reaches only some of them is
 * refused here rather than installed as two copies.
 */
export function workspacePins(tree) {
  const manifests = [
    ["package.json", readJson(join(tree, "package.json"))],
    ...packages.map((item) => [
      `${item.directory}/package.json`,
      readJson(join(tree, item.directory, "package.json")),
    ]),
  ];
  const pins = {};
  const owners = {};

  for (const [path, manifest] of manifests) {
    assert.equal(manifest.catalog, undefined, `${path} must name versions, not a catalog`);
    for (const section of ["dependencies", "devDependencies"]) {
      for (const [name, value] of Object.entries(manifest[section] ?? {})) {
        if (value === "workspace:*" && packages.some((item) => item.name === name)) continue;
        assert.ok(
          /^(?:npm:(?:@[a-z0-9-]+\/)?[a-z0-9.-]+@)?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(value),
          `${path} must pin ${name} to an exact registry version`,
        );
        assert.ok(
          pins[name] === undefined || pins[name] === value,
          `${name} is ${pins[name]} in ${owners[name]} but ${value} in ${path}`,
        );
        pins[name] = value;
        owners[name] ??= path;
      }
    }
  }
  // Each testing release depends on exactly the framework release it was published with.
  if (pins["@effect-agent/testing"] !== undefined)
    assert.equal(
      pins["@effect-agent/testing"],
      pins["effect-agent"],
      "@effect-agent/testing must be the effect-agent release",
    );

  return pins;
}
