import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packages } from "./packages.mjs";

export async function verifyConsumer(directory, artifactDirectory, profile) {
  assert.ok(["resources", "generic", "agent"].includes(profile));
  const root = realpathSync(directory), require = createRequire(join(root, "package.json"));
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
  for (const forbidden of profile === "agent" ? [] : ["effect-agent", "@effect-agent/platform-browserbase", "@effect-agent/testing"]) {
    assert.throws(() => require.resolve(forbidden), (error) => error.code === "MODULE_NOT_FOUND", `Forbidden dependency is installed: ${forbidden}`);
  }
  if (profile === "resources") assert.throws(() => require.resolve("playwright-core"), (error) => error.code === "MODULE_NOT_FOUND", "Resources-only installed Playwright");
  if (profile === "agent") {
    const adapterRequire = createRequire(join(installed.get(packages[1].name), "dist/index.mjs"));
    assert.equal(realpathSync(adapterRequire.resolve(packages[0].name)), realpathSync(require.resolve(packages[0].name)), "Adapter and consumer do not share the same candidate generic package");
    for (const old of ["interactive-browser", "types", "recordings", "replays", "downloads", "capture", "page-control"]) {
      assert.throws(() => require.resolve(`${packages[1].name}/${old}`), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", `Superseded export still resolves: ${old}`);
    }
  }
  return { profile, runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`, sourceSha: receipt.sourceSha, packages: [...installed.keys()], result: "candidate identity and canonical exports verified" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, artifacts, profile] = process.argv.slice(2);
  console.log(JSON.stringify(await verifyConsumer(directory, artifacts, profile)));
}
