import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { consumerPackageSet, consumerProfiles, packages, readJson } from "./packages.mjs";

// Check installation identity, not just root resolution: nested dependencies and
// npm aliases can be invisible at the root, and exports can hide package.json.
// Traverse package directories and supported local stores, never package code.
function checkInstalledDependencies(root, profile) {
  const forbidden = (name) =>
    name === "@browserbasehq/sdk" ||
    name === "effect-agent-browserbase" ||
    (!profile.startsWith("agent") &&
      (name === "effect-agent" ||
        name.startsWith("@effect-agent/") ||
        name === packages[2].name)) ||
    (["browser", "agent"].includes(profile) && name === packages[1].name) ||
    (profile === "resources" &&
      ["playwright", "playwright-core", "@playwright/test"].includes(name));

  const pending = [],
    seen = new Set();

  const identities = new Map(
    [...packages.map(({ name }) => name), "effect-agent"].map((name) => [name, new Set()]),
  );

  let admitted = 0;

  const enqueue = (kind, path, name = "") => {
    // This is a finite installation audit, not an unbounded filesystem crawler.
    assert.ok(++admitted <= 20_000, "Installed dependency audit exceeded its directory bound");
    pending.push({ kind, path, name });
  };

  enqueue("modules", join(root, "node_modules"));
  while (pending.length > 0) {
    const { kind, path, name } = pending.pop();
    const directory = realpathSync(path);

    assert.ok(directory.startsWith(root + sep), "Dependency resolves outside this clean consumer");
    assert.ok(statSync(directory).isDirectory(), "Expected an installed dependency directory");
    if (kind === "package") assert.ok(!forbidden(name), `Forbidden installed dependency: ${name}`);
    const key = kind + ":" + directory;

    if (seen.has(key)) continue;
    seen.add(key);
    if (kind === "package") {
      const manifestPath = join(directory, "package.json");

      if (existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);

        assert.equal(typeof manifest.name, "string", "Installed package must identify itself");
        assert.ok(!forbidden(manifest.name), `Forbidden installed dependency: ${manifest.name}`);
        const directories = identities.get(manifest.name);

        if (directories !== undefined) {
          directories.add(directory);
          assert.equal(directories.size, 1, `Multiple installed ${manifest.name} registries`);
        }
      }
      const nested = join(directory, "node_modules");

      if (existsSync(nested)) enqueue("modules", nested);
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".bin" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const child = join(directory, entry.name);

      if (kind === "store") {
        const nested = entry.name === "node_modules" ? child : join(child, "node_modules");

        if (existsSync(nested)) enqueue("modules", nested);
      } else if (kind === "scope") {
        enqueue("package", child, `${basename(directory)}/${entry.name}`);
      } else if (entry.name === ".bun" || entry.name === ".pnpm") {
        enqueue("store", child);
      } else if (entry.name.startsWith("@")) {
        enqueue("scope", child);
      } else if (!entry.name.startsWith(".")) {
        enqueue("package", child, entry.name);
      }
    }
  }

  return identities;
}

export async function verifyConsumer(directory, artifactDirectory, profile) {
  assert.ok(consumerProfiles.includes(profile));

  const root = realpathSync(directory),
    require = createRequire(join(root, "package.json"));

  const identities = checkInstalledDependencies(root, profile);
  const receipt = JSON.parse(readFileSync(join(artifactDirectory, "release-set.json"), "utf8"));
  const frameworkDirectory = identities.get("effect-agent").values().next().value;
  let frameworkManifest;

  if (profile.startsWith("agent")) {
    assert.ok(
      frameworkDirectory,
      "The qualified effect-agent host peer must be installed in this consumer",
    );
    frameworkManifest = readJson(join(frameworkDirectory, "package.json"));
    assert.equal(
      frameworkManifest.version,
      receipt.frameworkVersion,
      "Installed effect-agent differs from the qualified framework version",
    );
  }
  // Resolution walks the consumer's ancestors, so an unrelated `node_modules` above a
  // temporary root can answer for a forbidden specifier. That is host state rather than
  // something this candidate installed, and the audit above is the authority on what is
  // installed. Reaching into the consumer stays a failure, and an ambient answer is kept
  // in the receipt so a neutralized probe is never read as a clean one.
  const ambient = [];

  const refuse = (specifier, message) => {
    let resolved;

    try {
      resolved = require.resolve(specifier);
    } catch (error) {
      assert.equal(
        error.code,
        "MODULE_NOT_FOUND",
        `Unexpected resolution failure for ${specifier}`,
      );

      return;
    }
    assert.ok(!realpathSync(resolved).startsWith(root + sep), message);
    ambient.push({ specifier, resolved });
  };

  for (const forbidden of [
    "@browserbasehq/sdk",
    "effect-agent-browserbase",
    ...(!profile.startsWith("agent")
      ? ["effect-agent", "effect-agent-browser", "@effect-agent/testing"]
      : []),
    ...(["browser", "agent"].includes(profile) ? ["effect-browserbase"] : []),
  ])
    refuse(forbidden, `Forbidden dependency is installed: ${forbidden}`);
  if (profile === "resources") refuse("playwright-core", "Resources-only installed Playwright");
  const expected = consumerPackageSet(profile);

  const installed = new Map(),
    browserModules = new Map();

  for (const item of expected) {
    const entry = receipt.packages.find((entry) => entry.name === item.name);

    assert.ok(entry);
    const resolved = realpathSync(require.resolve(item.name));

    assert.ok(resolved.startsWith(root + sep), "Candidate resolves outside this clean consumer");
    const packageRoot = dirname(dirname(resolved));

    installed.set(item.name, packageRoot);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

    assert.equal(manifest.name, item.name);
    assert.equal(manifest.version, receipt.version);
    const tarball = join(artifactDirectory, entry.filename);

    const paths = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 })
      .trim()
      .split("\n");

    for (const path of paths) {
      const name = path.slice("package/".length);
      const actual = join(packageRoot, name);

      assert.ok(existsSync(actual), `Missing installed candidate member: ${name}`);
      assert.deepEqual(
        readFileSync(actual),
        execFileSync("tar", ["-xOf", tarball, path], {
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        }),
        `Installed bytes differ from the candidate: ${item.name}/${name}`,
      );
    }
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const specifier = item.name + (subpath === "." ? "" : subpath.slice(1));
      const file = realpathSync(require.resolve(specifier));

      assert.equal(file, realpathSync(join(packageRoot, target.default)));
      const module = await import(pathToFileURL(file).href);

      if (item === packages[0])
        browserModules.set(subpath, { module, stem: basename(target.default, ".mjs") });
    }
  }
  const browserRoot = browserModules.get(".").module;

  assert.equal(browserRoot.Chromium, undefined, "Chromium must remain an isolated subpath");
  for (const [subpath, { module, stem }] of browserModules) {
    if (subpath === "." || !Object.hasOwn(browserRoot, stem)) continue;
    const namespace = browserRoot[stem];

    assert.deepEqual(
      Object.keys(namespace).sort(),
      Object.keys(module).sort(),
      `Browser root and ${subpath} expose different members`,
    );
    for (const [name, value] of Object.entries(module)) {
      assert.equal(namespace[name], value, `Browser root and ${subpath} duplicate ${name}`);
    }
  }
  for (const item of expected.filter((item) => item !== packages[0])) {
    const dependentRequire = createRequire(join(installed.get(item.name), "dist/index.mjs"));

    for (const subpath of browserModules.keys()) {
      const specifier = packages[0].name + (subpath === "." ? "" : subpath.slice(1));

      assert.equal(
        realpathSync(dependentRequire.resolve(specifier)),
        realpathSync(require.resolve(specifier)),
        `${item.name} and consumer do not share the same candidate browser export: ${specifier}`,
      );
    }
  }
  if (profile.startsWith("agent")) {
    const adapterRequire = createRequire(join(installed.get(packages[2].name), "dist/index.mjs"));

    // Count physical framework copies above, then check every public host import
    // resolves to that same copy when used by the adapter.
    for (const subpath of Object.keys(frameworkManifest.exports)) {
      const specifier = "effect-agent" + (subpath === "." ? "" : subpath.slice(1));
      const host = realpathSync(require.resolve(specifier));

      assert.ok(
        host.startsWith(frameworkDirectory + sep),
        "Framework export resolves outside the installed host peer",
      );
      assert.equal(
        realpathSync(adapterRequire.resolve(specifier)),
        host,
        `Adapter and consumer do not share the same framework export: ${specifier}`,
      );
    }
    const frameworkRoot = await import(pathToFileURL(require.resolve("effect-agent")).href);

    for (const [namespace, subpath] of [
      ["InteractiveBrowser", "interactive-browser"],
      ["PageScreenshot", "page-screenshot"],
      ["Sandbox", "sandbox"],
    ]) {
      const module = await import(pathToFileURL(require.resolve(`effect-agent/${subpath}`)).href);

      // Published beta.102 subpaths also expose build aliases. Check each root
      // contract's identity without imposing our packages' export policy upstream.
      const contracts = Object.entries(frameworkRoot[namespace] ?? {});

      assert.ok(contracts.length > 0, `Framework root omits ${namespace} contracts`);
      for (const [name, value] of contracts) {
        assert.ok(Object.hasOwn(module, name), `Framework ${subpath} omits root contract ${name}`);
        assert.equal(module[name], value, `Framework root and ${subpath} duplicate ${name}`);
      }
    }
    // Node reports a blocked subpath as ERR_PACKAGE_PATH_NOT_EXPORTED; Bun raises an
    // ordinary resolution failure. Both mean the retired subpath is gone, and neither
    // may be satisfied by an unrelated throw, so the specifier itself must be named.
    for (const old of [
      "interactive-browser",
      "types",
      "recordings",
      "replays",
      "downloads",
      "capture",
      "page-control",
    ]) {
      const specifier = `${packages[2].name}/${old}`;

      assert.throws(
        () => require.resolve(specifier),
        (error) =>
          error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
          ((error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") &&
            String(error.message).includes(specifier)),
        `Superseded export still resolves: ${old}`,
      );
    }
  }

  return {
    profile,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    sourceSha: receipt.sourceSha,
    packages: [...installed.keys()],
    ...(frameworkManifest === undefined ? {} : { frameworkVersion: frameworkManifest.version }),
    ...(ambient.length === 0 ? {} : { ambient }),
    result: "candidate identity and canonical exports verified",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, artifacts, profile] = process.argv.slice(2);

  console.log(JSON.stringify(await verifyConsumer(directory, artifacts, profile)));
}
