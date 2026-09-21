import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packages, readJson } from "./packages.mjs";

// Check installation identity, not just root resolution: nested dependencies and
// npm aliases can be invisible at the root, and exports can hide package.json.
// Traverse package directories and supported local stores, never package code.
function checkInstalledDependencies(root, profile) {
  const forbidden = (name) =>
    (profile !== "agent" && (name === "@browserbasehq/sdk" || name === "effect-agent" ||
      name.startsWith("@effect-agent/") || name === packages[1].name)) ||
    (profile === "resources" && ["playwright", "playwright-core", "@playwright/test"].includes(name));
  const pending = [], seen = new Set();
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
}

export async function verifyConsumer(directory, artifactDirectory, profile) {
  assert.ok(["resources", "generic", "agent"].includes(profile));
  const root = realpathSync(directory), require = createRequire(join(root, "package.json"));
  checkInstalledDependencies(root, profile);
  // Resolution walks the consumer's ancestors, so an unrelated `node_modules` above a
  // temporary root can answer for a forbidden specifier. That is host state rather than
  // something this candidate installed, and the audit above is the authority on what is
  // installed. Reaching into the consumer stays a failure, and an ambient answer is kept
  // in the receipt so a neutralized probe is never read as a clean one.
  const ambient = [];
  const refuse = (specifier, message) => {
    let resolved;
    try { resolved = require.resolve(specifier); } catch (error) {
      assert.equal(error.code, "MODULE_NOT_FOUND", `Unexpected resolution failure for ${specifier}`);
      return;
    }
    assert.ok(!realpathSync(resolved).startsWith(root + sep), message);
    ambient.push({ specifier, resolved });
  };
  for (const forbidden of profile === "agent" ? [] : ["effect-agent", "effect-agent-browserbase", "@effect-agent/testing", "@browserbasehq/sdk"])
    refuse(forbidden, `Forbidden dependency is installed: ${forbidden}`);
  if (profile === "resources") refuse("playwright-core", "Resources-only installed Playwright");
  const receipt = JSON.parse(readFileSync(join(artifactDirectory, "release-set.json"), "utf8"));
  const expected = profile === "agent" ? packages : [packages[0]];
  const installed = new Map();
  for (const item of expected) {
    const entry = receipt.packages.find((entry) => entry.name === item.name);
    assert.ok(entry);
    const resolved = realpathSync(require.resolve(item.name));
    assert.ok(resolved.startsWith(root + sep), "Candidate resolves outside this clean consumer");
    const packageRoot = dirname(dirname(resolved));
    installed.set(item.name, packageRoot);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.name, item.name); assert.equal(manifest.version, receipt.version);
    const tarball = join(artifactDirectory, entry.filename);
    const paths = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 }).trim().split("\n");
    for (const path of paths) {
      const name = path.slice("package/".length);
      const actual = join(packageRoot, name);
      assert.ok(existsSync(actual), `Missing installed candidate member: ${name}`);
      assert.deepEqual(readFileSync(actual), execFileSync("tar", ["-xOf", tarball, path], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }), `Installed bytes differ from the candidate: ${item.name}/${name}`);
    }
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const specifier = item.name + (subpath === "." ? "" : subpath.slice(1));
      const file = realpathSync(require.resolve(specifier));
      assert.equal(file, realpathSync(join(packageRoot, target.default)));
      await import(pathToFileURL(file).href);
    }
  }
  if (profile === "agent") {
    const adapterRequire = createRequire(join(installed.get(packages[1].name), "dist/index.mjs"));
    assert.equal(realpathSync(adapterRequire.resolve(packages[0].name)), realpathSync(require.resolve(packages[0].name)), "Adapter and consumer do not share the same candidate generic package");
    // Node reports a blocked subpath as ERR_PACKAGE_PATH_NOT_EXPORTED; Bun raises an
    // ordinary resolution failure. Both mean the retired subpath is gone, and neither
    // may be satisfied by an unrelated throw, so the specifier itself must be named.
    for (const old of ["interactive-browser", "types", "recordings", "replays", "downloads", "capture", "page-control"]) {
      const specifier = `${packages[1].name}/${old}`;
      assert.throws(() => require.resolve(specifier), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || ((error.code === "MODULE_NOT_FOUND" || error.code === "ERR_MODULE_NOT_FOUND") && String(error.message).includes(specifier)), `Superseded export still resolves: ${old}`);
    }
  }
  return { profile, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, sourceSha: receipt.sourceSha, packages: [...installed.keys()], ...(ambient.length === 0 ? {} : { ambient }), result: "candidate identity and canonical exports verified" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, artifacts, profile] = process.argv.slice(2);
  console.log(JSON.stringify(await verifyConsumer(directory, artifacts, profile)));
}
