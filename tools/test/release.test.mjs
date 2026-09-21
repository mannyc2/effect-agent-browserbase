import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkTag, distTag, packages, readPackageSet, repositoryUrl } from "../packages.mjs";
import { checkPackagePaths, distributionFiles, packageReleaseSet, publicationManifest, releaseSetDigest } from "../package-release.mjs";
import { packedConsumers } from "../packed-consumers.mjs";
import { publishReleaseSet } from "../publish-release.mjs";
import { verifyReleaseSet } from "../verify-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const version = "0.1.0-beta.102";
const sha = "1234567890abcdef1234567890abcdef12345678";
const versions = { [packages[0].name]: version, "effect-agent": version };
const source = (index) => ({
  name: packages[index].name, version, license: "MIT", type: "module", sideEffects: [],
  repository: { type: "git", url: repositoryUrl, directory: packages[index].directory },
  exports: index === 0 ? { ".": "./src/index.ts", "./client": "./src/Client.ts" } : { ".": "./src/index.ts", "./adapter": "./src/Adapter.ts", "./tools": "./src/Tools.ts" },
  dependencies: index === 0 ? {} : { [packages[0].name]: "workspace:*", "effect-agent": "workspace:*" },
  peerDependencies: { effect: "^4.0.0-rc.115", ...(index === 0 ? { "playwright-core": "1.63.0" } : {}) },
  ...(index === 0 ? { peerDependenciesMeta: { "playwright-core": { optional: true } } } : {}),
  devDependencies: { typescript: "catalog:" }, scripts: { build: "vp pack" }, files: ["dist", "src"],
});
const manifest = (index) => publicationManifest(source(index), {}, versions);
const paths = (value) => ["package/package.json", "package/README.md", "package/LICENSE", ...Object.values(value.exports).flatMap((entry) => Object.values(entry).map((path) => `package/${path.slice(2)}`))];
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function workspace(t, modify) {
  const directory = temporary(t), tree = join(directory, "tree"), out = join(directory, "output");
  mkdirSync(join(tree, "packages/effect-agent"), { recursive: true }); mkdirSync(out);
  writeFileSync(join(tree, "package.json"), JSON.stringify({ catalog: {} }));
  writeFileSync(join(tree, "packages/effect-agent/package.json"), JSON.stringify({ version }));
  for (const [index, item] of packages.entries()) {
    const pkg = join(tree, item.directory);
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify(source(index)));
    writeFileSync(join(pkg, "README.md"), "# Offline packaging fixture, not a runtime implementation\n");
    cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
    for (const path of paths(manifest(index)).filter((path) => path.startsWith("package/dist/"))) {
      const target = join(pkg, path.slice("package/".length));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "export {};\n");
    }
  }
  modify?.(tree);
  return { tree, out };
}

// These fixtures exercise real npm packing/receipt inspection, not a substitute
// for the three production tarball consumers required by packed-consumer.sh.
test("only the two canonical packages may enter the dependency-ordered release set", () => {
  assert.deepEqual(packages.map((p) => p.name), ["effect-browserbase", "effect-agent-browserbase"]);
  assert.equal(manifest(0).repository.url, repositoryUrl);
  assert.throws(() => publicationManifest({ ...source(0), name: "effect-agent" }, {}, versions), /Only this repository/);
  assert.throws(() => publicationManifest({ ...source(0), repository: { ...source(0).repository, url: "https://elsewhere.invalid" } }, {}, versions), /OIDC identity/);
});

test("normalization strips dev/source/scripts without mutating inputs, and resolves exact workspace edges", () => {
  for (const index of [0, 1]) {
    const input = source(index), original = JSON.stringify(input);
    const output = publicationManifest(input, {}, versions);
    assert.deepEqual(output.files, ["dist"]); assert.equal(output.scripts, undefined); assert.equal(output.devDependencies, undefined);
    assert.deepEqual(output.exports["."], { types: "./dist/index.d.mts", default: "./dist/index.mjs" });
    output.repository.url = "wrong"; assert.equal(JSON.stringify(input), original);
  }
  assert.deepEqual(manifest(0).dependencies, {});
  assert.deepEqual(manifest(1).dependencies, versions);
  assert.equal(manifest(1).peerDependencies["playwright-core"], undefined);
});

test("framework leakage, native peer on adapter, private packages and unexpected edges are rejected", () => {
  assert.throws(() => publicationManifest({ ...source(0), private: true }, {}, versions), /private/);
  assert.throws(() => publicationManifest({ ...source(0), devDependencies: { "@effect-agent/testing": "workspace:*" } }, {}, versions), /Generic package/);
  assert.throws(() => publicationManifest({ ...source(0), dependencies: { "effect-agent": version } }, {}, versions), /regular dependency/);
  assert.throws(() => publicationManifest({ ...source(1), peerDependencies: { ...source(1).peerDependencies, "playwright-core": "1.63.0" } }, {}, versions), /peer dependency/);
  assert.throws(() => publicationManifest(source(1), {}, {}), /Unresolved/);
  assert.throws(() => publicationManifest({ ...source(1), dependencies: { ...source(1).dependencies, other: "workspace:*" } }, {}, versions), /regular dependency/);
});

test("legacy exports, wildcard/private paths and duplicate aliases cannot enter the adapter", () => {
  assert.throws(() => publicationManifest({ ...source(1), exports: { ...source(1).exports, "./interactive-browser": "./src/InteractiveBrowser.ts" } }, {}, versions), /only the canonical/);
  for (const exports of [
    { ".": "./src/../secret.ts" }, { ".": "./src/index.ts", "./internal": "./src/Internal.ts" },
    { ".": "./src/index.ts", "./alias": "./src/index.ts" }, { ".": "./src/index.ts", "./*": "./src/index.ts" },
  ]) assert.throws(() => publicationManifest({ ...source(0), exports }, {}, versions));
  const value = manifest(0), members = paths(value);
  checkPackagePaths(members, value);
  assert.throws(() => checkPackagePaths(members.filter((p) => !p.endsWith("index.d.mts")), value), /Missing built export/);
  assert.throws(() => checkPackagePaths([...members, "package/src/secret.ts"], value), /Unexpected/);
  assert.throws(() => checkPackagePaths([...members, "package/dist/../../secret.mjs"], value), /Non-canonical/);
  assert.throws(() => checkPackagePaths([...members, members[0]], value), /Duplicate/);
});

test("coordinated package versions and Effect peer contracts are checked before packing", (t) => {
  const { tree } = workspace(t);
  assert.equal(readPackageSet(tree).length, 2);
  const path = join(tree, packages[1].directory, "package.json");
  writeFileSync(path, JSON.stringify({ ...source(1), version: "0.1.0-beta.103" }));
  assert.throws(() => readPackageSet(tree), /coordinated version/);
  writeFileSync(path, JSON.stringify({ ...source(1), peerDependencies: { effect: "^4.0.0-rc.116" } }));
  assert.throws(() => readPackageSet(tree), /Effect peer/);
});

test("release channels and tags reject ambiguous or shell-like input", () => {
  for (const channel of ["alpha", "beta", "rc"]) { assert.equal(distTag(`0.1.0-${channel}.1`), channel); checkTag(`v0.1.0-${channel}.1`, `0.1.0-${channel}.1`); }
  assert.equal(distTag("1.0.0"), "latest");
  for (const input of ["01.0.0", "1.0.0-beta.01", "1.0.0-next.1", "$(touch bad)", "1.0.0\n"]) assert.throws(() => distTag(input), /Expected/);
  assert.throws(() => checkTag("main", version), /exactly match/);
});

test("unexpected files and symlinks cannot be packed", (t) => {
  const dir = temporary(t); writeFileSync(join(dir, "index.mjs"), "export {};\n");
  assert.deepEqual(distributionFiles(dir), ["index.mjs"]);
  writeFileSync(join(dir, ".env"), "NOT_A_SECRET=test\n"); assert.throws(() => distributionFiles(dir), /Unexpected build output/);
  rmSync(join(dir, ".env")); symlinkSync(join(dir, "index.mjs"), join(dir, "outside.mjs")); assert.throws(() => distributionFiles(dir), /Symlinks/);
});

test("real offline npm packs two immutable artifacts bound to one independently checked receipt", (t) => {
  const { tree, out } = workspace(t);
  const receipt = packageReleaseSet(tree, out, sha), digest = releaseSetDigest(out);
  assert.equal(receipt.packages.length, 2); assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(verifyReleaseSet(out, sha, `v${version}`, digest), receipt);
  assert.throws(() => verifyReleaseSet(out, "f".repeat(40), `v${version}`, digest), /another source/);
  assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, "0".repeat(64)), /successful build/);
  assert.throws(() => packageReleaseSet(tree, out, sha), /existing package stage/);
  const file = join(out, receipt.packages[1].filename), bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 1; writeFileSync(file, bytes);
  assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, digest), /successful build/);
});

test("missing, reordered, extra or mixed-version receipt entries fail even with a supplied matching receipt digest", (t) => {
  const { tree, out } = workspace(t), receipt = packageReleaseSet(tree, out, sha);
  for (const entries of [[receipt.packages[0]], [...receipt.packages].reverse(), [...receipt.packages, receipt.packages[0]], [receipt.packages[0], { ...receipt.packages[1], version: "0.1.0-beta.103" }]]) {
    writeFileSync(join(out, "release-set.json"), JSON.stringify({ ...receipt, packages: entries }));
    assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, releaseSetDigest(out)));
  }
});

test("transitive generic declarations may not import the optional native or framework types", (t) => {
  const { tree, out } = workspace(t, (tree) => writeFileSync(join(tree, packages[0].directory, "dist/Hidden.d.mts"), 'export type { Page } from "playwright-core";\n'));
  packageReleaseSet(tree, out, sha);
  assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, releaseSetDigest(out)), /Generic declaration imports/);
});

test("the retired publisher refuses live execution before any artifact or command access", () => {
  let called = false;
  assert.throws(() => publishReleaseSet("/nonexistent-release", sha, `v${version}`, "0".repeat(64), {
    publish: true,
    run: () => { called = true; },
  }), /Live publication requires.*journal/);
  assert.equal(called, false);
});

test("acceptance retains dependency-ordered lifecycle-free npm dry-runs", (t) => {
  const { tree, out } = workspace(t), receipt = packageReleaseSet(tree, out, sha), digest = releaseSetDigest(out);
  const calls = [];
  const results = publishReleaseSet(out, sha, `v${version}`, digest, { run: (args) => { calls.push(args); return "{}"; } });
  assert.deepEqual(results.map((result) => result.state), ["dry-run", "dry-run"]);
  assert.deepEqual(calls.map((args) => args[1]), receipt.packages.map((entry) => join(out, entry.filename)));
  assert.ok(calls.every((args) => args[0] === "publish" && args.includes("--dry-run") && args.includes("--ignore-scripts") && args.includes("--provenance=false")));
  assert.deepEqual(readFileSync(join(out, "publication-dry-run.ndjson"), "utf8").trim().split("\n").map(JSON.parse), results);
});

for (const declarationExit of [0, 1]) {
  test(`packed consumer receipts retain the raw declaration exit ${declarationExit}`, (t) => {
    const { tree, out } = workspace(t, (tree) => {
      writeFileSync(join(tree, "package.json"), JSON.stringify({ catalog: {
        effect: "4.0.0-rc.115", "@types/node": "26.1.2", typescript: "7.0.2",
        "vite-plus": "0.3.2", "playwright-core": "1.63.0", "@effect/vitest": "4.0.0-rc.115", vitest: "4.1.11",
      } }));
      for (const item of packages) {
        const pkg = join(tree, item.directory);
        for (const file of ["test/consumer/resources.ts", "test/consumer/native.ts", "test/consumer/agent.ts", "test/native/fixture.test.ts", "examples/fixture.ts", "vite.native.config.ts"]) {
          const target = join(pkg, file);
          mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, "export {};\n");
        }
      }
    });
    const diagnostic = "node_modules/effect-agent/dist/capabilities/MemoryNotes.d.mts(330,108): error TS2304: Cannot find name 'S'.\n";
    // Only the external command boundary is substituted. Real packing, fixture staging,
    // strict configuration and receipt aggregation run; no installs or browsers run here.
    const commands = t.mock.method(childProcess, "spawnSync", (_command, args, options) => {
      const failing = options.cwd === join(out, "consumers/agent") && args[0] === "run" && args[1] === "check";
      return { status: failing ? declarationExit : 0, signal: null, stdout: failing && declarationExit !== 0 ? diagnostic : "", stderr: "" };
    });
    syncBuiltinESMExports();
    t.after(() => { commands.mock.restore(); syncBuiltinESMExports(); });
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});

    if (declarationExit === 0) packedConsumers(tree, out, sha);
    else assert.throws(() => packedConsumers(tree, out, sha), /One or more canonical consumer gates failed/);

    const records = readFileSync(join(out, "consumer-statuses.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((record) => record.step === "declarations"), [
      { profile: "resources", step: "declarations", exitCode: 0, signal: null, passed: true },
      { profile: "generic", step: "declarations", exitCode: 0, signal: null, passed: true },
      { profile: "agent", step: "declarations", exitCode: declarationExit, signal: null, passed: declarationExit === 0 },
    ]);
    assert.equal(records.every((record) => record.passed), declarationExit === 0);
    assert.equal(readFileSync(join(out, "consumer-agent-declarations.log"), "utf8"), declarationExit === 0 ? "" : diagnostic);
    assert.equal(records.filter((record) => record.step.endsWith("-workflow")).length, 6);
    for (const profile of ["resources", "generic", "agent"]) {
      const config = JSON.parse(readFileSync(join(out, "consumers", profile, "tsconfig.json"), "utf8"));
      assert.equal(config.compilerOptions.strict, true);
      assert.equal(config.compilerOptions.skipLibCheck, false);
    }
  });
}
