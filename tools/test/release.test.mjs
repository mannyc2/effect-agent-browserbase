import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkPackagePaths,
  distributionFiles,
  packageReleaseSet,
  publicationManifest,
  releaseSetDigest,
} from "../package-release.mjs";
import {
  checkManifest,
  checkTag,
  consumerProfiles,
  distTag,
  packages,
  readPackageSet,
  repositoryUrl,
} from "../packages.mjs";
import { checkConsumerHostPeers, consumerManifest, packedConsumers } from "../packed-consumers.mjs";
import { publishReleaseSet } from "../publish-release.mjs";
import { verifyReleaseSet } from "../verify-release.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const version = "0.2.0-beta.0";
const frameworkVersion = "0.1.0-beta.102";
const sha = "1234567890abcdef1234567890abcdef12345678";

const versions = {
  ...Object.fromEntries(packages.map((item) => [item.name, version])),
  "effect-agent": frameworkVersion,
};

const source = (index) => ({
  name: packages[index].name,
  version,
  license: "MIT",
  type: "module",
  sideEffects: [],
  repository: { type: "git", url: repositoryUrl, directory: packages[index].directory },
  exports:
    index < 2
      ? { ".": "./src/index.ts", "./client": "./src/Client.ts" }
      : { ".": "./src/index.ts", "./adapter": "./src/Adapter.ts", "./tools": "./src/Tools.ts" },
  peerDependencies: {
    effect: "^4.0.0-rc.115",
    ...(index === 0 ? { "playwright-core": "1.63.0" } : { "effect-browser": "workspace:*" }),
    ...(index === 2 ? { "effect-agent": "workspace:*" } : {}),
  },
  ...(index === 0 ? { peerDependenciesMeta: { "playwright-core": { optional: true } } } : {}),
  devDependencies: {
    typescript: "catalog:",
    ...(index === 0 ? {} : { "effect-browser": "workspace:*" }),
    ...(index === 2 ? { "effect-agent": "workspace:*" } : {}),
  },
  scripts: { build: "vp pack" },
  files: ["dist", "src"],
});

const manifest = (index) => publicationManifest(source(index), {}, versions);

const paths = (value) => [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  ...Object.values(value.exports).flatMap((entry) =>
    Object.values(entry).map((path) => `package/${path.slice(2)}`),
  ),
];

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-release-test-"));

  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}
function workspace(t, modify) {
  const directory = temporary(t),
    tree = join(directory, "tree"),
    out = join(directory, "output");

  mkdirSync(join(tree, "packages/effect-agent"), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(tree, "package.json"), JSON.stringify({ catalog: {} }));
  writeFileSync(
    join(tree, "packages/effect-agent/package.json"),
    JSON.stringify({ version: frameworkVersion }),
  );
  for (const [index, item] of packages.entries()) {
    const pkg = join(tree, item.directory);

    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify(source(index)));
    writeFileSync(
      join(pkg, "README.md"),
      "# Offline packaging fixture, not a runtime implementation\n",
    );
    cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));
    for (const path of paths(manifest(index)).filter((path) => path.startsWith("package/dist/"))) {
      const target = join(pkg, path.slice("package/".length));

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "export {};\n");
    }
  }
  modify?.(tree);

  return { tree, out };
}

// These fixtures exercise real npm packing/receipt inspection, not a substitute
// for the five production tarball consumers required by packed-consumer.sh.
test("only the three canonical packages may enter the dependency-ordered release set", () => {
  assert.deepEqual(
    packages.map((p) => p.name),
    ["effect-browser", "effect-browserbase", "effect-agent-browser"],
  );
  assert.equal(manifest(0).repository.url, repositoryUrl);
  assert.throws(
    () => publicationManifest({ ...source(0), name: "effect-agent" }, {}, versions),
    /Only this repository/,
  );
  assert.throws(
    () =>
      publicationManifest(
        { ...source(0), repository: { ...source(0).repository, url: "https://elsewhere.invalid" } },
        {},
        versions,
      ),
    /OIDC identity/,
  );
});

test("normalization strips dev/source/scripts without mutating inputs, and resolves exact host peers", () => {
  for (const index of [0, 1, 2]) {
    const input = source(index),
      original = JSON.stringify(input);

    const output = publicationManifest(input, {}, versions);

    assert.deepEqual(output.files, ["dist"]);
    assert.equal(output.scripts, undefined);
    assert.equal(output.devDependencies, undefined);
    assert.deepEqual(output.exports["."], {
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    });
    assert.equal(output.dependencies, undefined);
    assert.doesNotMatch(JSON.stringify(output), /workspace:|catalog:/);
    output.repository.url = "wrong";
    assert.equal(JSON.stringify(input), original);
  }
  assert.deepEqual(manifest(0).peerDependencies, {
    effect: "^4.0.0-rc.115",
    "playwright-core": "1.63.0",
  });
  assert.deepEqual(manifest(0).peerDependenciesMeta, { "playwright-core": { optional: true } });
  assert.deepEqual(manifest(1).peerDependencies, {
    effect: "^4.0.0-rc.115",
    "effect-browser": version,
  });
  assert.deepEqual(manifest(2).peerDependencies, {
    effect: "^4.0.0-rc.115",
    "effect-browser": version,
    "effect-agent": frameworkVersion,
  });
  assert.equal(manifest(1).peerDependencies["playwright-core"], undefined);
});

test("host peers require matching development edges and cannot publish optional or widened contracts", () => {
  for (const [index, name] of [
    [1, "effect-browser"],
    [2, "effect-browser"],
    [2, "effect-agent"],
  ]) {
    const input = source(index);

    delete input.devDependencies[name];
    assert.throws(
      () => publicationManifest(input, {}, versions),
      /workspace development dependency/,
    );
    const required = source(index);

    delete required.peerDependencies[name];
    assert.throws(() => publicationManifest(required, {}, versions), /peer dependency edge/);
    assert.throws(
      () =>
        publicationManifest(
          { ...source(index), dependencies: { [name]: "workspace:*" } },
          {},
          versions,
        ),
      /regular dependency edge/,
    );
    assert.throws(() =>
      publicationManifest(
        { ...source(index), peerDependenciesMeta: { [name]: { optional: true } } },
        {},
        versions,
      ),
    );
    const output = manifest(index);

    output.peerDependencies[name] = "^" + versions[name];
    assert.throws(
      () => checkManifest(output, { built: true, browserVersion: version, frameworkVersion }),
      /must be exact/,
    );
  }
});

test("framework leakage, native peer on adapter, private packages and unexpected edges are rejected", () => {
  assert.throws(
    () => publicationManifest({ ...source(0), private: true }, {}, versions),
    /private/,
  );
  assert.throws(
    () =>
      publicationManifest(
        { ...source(0), devDependencies: { "@effect-agent/testing": "workspace:*" } },
        {},
        versions,
      ),
    /Generic package/,
  );
  assert.throws(
    () =>
      publicationManifest(
        { ...source(0), dependencies: { "effect-agent": version } },
        {},
        versions,
      ),
    /regular dependency/,
  );
  assert.throws(
    () =>
      publicationManifest(
        {
          ...source(2),
          peerDependencies: { ...source(2).peerDependencies, "playwright-core": "1.63.0" },
        },
        {},
        versions,
      ),
    /peer dependency/,
  );
  assert.throws(() => publicationManifest(source(1), {}, {}), /Unresolved/);
  assert.throws(
    () =>
      publicationManifest(
        { ...source(1), dependencies: { ...source(1).dependencies, other: "workspace:*" } },
        {},
        versions,
      ),
    /regular dependency/,
  );
});

test("legacy exports, wildcard/private paths and duplicate aliases cannot enter the adapter", () => {
  assert.throws(
    () =>
      publicationManifest(
        {
          ...source(2),
          exports: { ...source(2).exports, "./interactive-browser": "./src/InteractiveBrowser.ts" },
        },
        {},
        versions,
      ),
    /only the canonical/,
  );
  for (const exports of [
    { ".": "./src/../secret.ts" },
    { ".": "./src/index.ts", "./internal": "./src/Internal.ts" },
    { ".": "./src/index.ts", "./alias": "./src/index.ts" },
    { ".": "./src/index.ts", "./*": "./src/index.ts" },
  ])
    assert.throws(() => publicationManifest({ ...source(0), exports }, {}, versions));

  const value = manifest(0),
    members = paths(value);

  checkPackagePaths(members, value);
  assert.throws(
    () =>
      checkPackagePaths(
        members.filter((p) => !p.endsWith("index.d.mts")),
        value,
      ),
    /Missing built export/,
  );
  assert.throws(
    () => checkPackagePaths([...members, "package/src/secret.ts"], value),
    /Unexpected/,
  );
  assert.throws(
    () => checkPackagePaths([...members, "package/dist/../../secret.mjs"], value),
    /Non-canonical/,
  );
  assert.throws(() => checkPackagePaths([...members, members[0]], value), /Duplicate/);
});

test("coordinated package versions and Effect peer contracts are checked before packing", (t) => {
  const { tree } = workspace(t);

  assert.equal(readPackageSet(tree).length, 3);
  const path = join(tree, packages[1].directory, "package.json");

  writeFileSync(path, JSON.stringify({ ...source(1), version: "0.1.0-beta.103" }));
  assert.throws(() => readPackageSet(tree), /coordinated version/);
  writeFileSync(
    path,
    JSON.stringify({
      ...source(1),
      peerDependencies: { ...source(1).peerDependencies, effect: "^4.0.0-rc.116" },
    }),
  );
  assert.throws(() => readPackageSet(tree), /Effect peer/);
});

test("release channels and tags reject ambiguous or shell-like input", () => {
  for (const channel of ["alpha", "beta", "rc"]) {
    assert.equal(distTag(`0.1.0-${channel}.1`), channel);
    checkTag(`v0.1.0-${channel}.1`, `0.1.0-${channel}.1`);
  }
  assert.equal(distTag("1.0.0"), "latest");
  for (const input of ["01.0.0", "1.0.0-beta.01", "1.0.0-next.1", "$(touch bad)", "1.0.0\n"])
    assert.throws(() => distTag(input), /Expected/);
  assert.throws(() => checkTag("main", version), /exactly match/);
});

test("unexpected files and symlinks cannot be packed", (t) => {
  const dir = temporary(t);

  writeFileSync(join(dir, "index.mjs"), "export {};\n");
  assert.deepEqual(distributionFiles(dir), ["index.mjs"]);
  writeFileSync(join(dir, ".env"), "NOT_A_SECRET=test\n");
  assert.throws(() => distributionFiles(dir), /Unexpected build output/);
  rmSync(join(dir, ".env"));
  symlinkSync(join(dir, "index.mjs"), join(dir, "outside.mjs"));
  assert.throws(() => distributionFiles(dir), /Symlinks/);
});

test("real offline npm packs three immutable artifacts bound to one independently checked receipt", (t) => {
  const { tree, out } = workspace(t);

  const receipt = packageReleaseSet(tree, out, sha),
    digest = releaseSetDigest(out);

  assert.equal(receipt.packages.length, 3);
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(verifyReleaseSet(out, sha, `v${version}`, digest), receipt);
  assert.throws(
    () => verifyReleaseSet(out, "f".repeat(40), `v${version}`, digest),
    /another source/,
  );
  assert.throws(
    () => verifyReleaseSet(out, sha, `v${version}`, "0".repeat(64)),
    /successful build/,
  );
  assert.throws(() => packageReleaseSet(tree, out, sha), /existing package stage/);

  const file = join(out, receipt.packages[1].filename),
    bytes = readFileSync(file);

  bytes[bytes.length - 1] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, digest), /successful build/);
});

test("Bun staging checks actual archive peers and direct hosts before applying substitutions", (t) => {
  const { tree, out } = workspace(t),
    receipt = packageReleaseSet(tree, out, sha);

  const catalog = {
    effect: "4.0.0-rc.115",
    "@types/node": "26.1.2",
    typescript: "7.0.2",
    "vite-plus": "0.3.2",
    "playwright-core": "1.63.0",
    "@effect/vitest": "4.0.0-rc.115",
    "@effect/platform-node": "4.0.0-rc.115",
    vitest: "4.1.11",
  };

  for (const profile of consumerProfiles)
    checkConsumerHostPeers(profile, consumerManifest(profile, receipt, out, catalog), receipt, out);

  const original = consumerManifest("agent", receipt, out, catalog);

  assert.throws(
    () => checkConsumerHostPeers("agent", original, { ...receipt, version: "0.2.0-beta.1" }, out),
    /Candidate effect-browser version differs from the release set/,
  );

  const check = (change, expected) => {
    const input = structuredClone(original);

    change(input);
    assert.throws(() => checkConsumerHostPeers("agent", input, receipt, out), expected);
  };

  check((input) => {
    input.dependencies["effect-browser"] = "0.2.0-beta.1";
  }, /Direct effect-browser/);
  check((input) => {
    input.overrides["effect-browser"] = "file:/different-browser.tgz";
  }, /Unexpected candidate substitution/);
  check((input) => {
    input.dependencies["effect-agent"] = "0.1.0-beta.103";
  }, /Direct framework host/);
  check((input) => {
    input.overrides["effect-agent"] = frameworkVersion;
  }, /framework host must not be overridden/);

  // Receipt fields alone cannot prove the requirement inside the actual archive.
  const stage = join(out, "packed-stage/agent-browser");
  const candidate = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));

  for (const [peer, incompatible] of [
    ["effect-browser", "0.2.0-beta.1"],
    ["effect-agent", "0.1.0-beta.103"],
  ]) {
    const conflicting = structuredClone(candidate);

    conflicting.peerDependencies[peer] = incompatible;
    writeFileSync(join(stage, "package.json"), JSON.stringify(conflicting));
    childProcess.execFileSync(
      "npm",
      ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", out],
      {
        cwd: stage,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.throws(
      () => checkConsumerHostPeers("agent", original, receipt, out),
      new RegExp(`Host peer ${peer} does not match`),
    );
  }
});

test("actual npm installs direct host peers and rejects incompatible hosts without overrides", (t) => {
  const { tree, out } = workspace(t),
    receipt = packageReleaseSet(tree, out, sha);

  const pack = (directory) => {
    const [entry] = JSON.parse(
      childProcess.execFileSync(
        "npm",
        ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", out],
        { cwd: directory, encoding: "utf8", timeout: 30_000 },
      ),
    );

    return `file:${join(out, entry.filename)}`;
  };

  // These tiny host packages test npm's peer resolver, not Effect or framework behavior.
  const host = (name, version) => {
    const directory = join(out, `${name}-${version}`);

    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name, version, type: "module", exports: { ".": "./index.mjs" } }),
    );
    writeFileSync(join(directory, "index.mjs"), "export {};\n");

    return pack(directory);
  };

  const browserMismatch = join(out, "browser-mismatch");

  cpSync(join(out, "packed-stage/browser"), browserMismatch, { recursive: true });
  const browserManifest = JSON.parse(readFileSync(join(browserMismatch, "package.json"), "utf8"));

  browserManifest.version = "0.2.0-beta.1";
  writeFileSync(join(browserMismatch, "package.json"), JSON.stringify(browserManifest));
  const incompatibleBrowser = pack(browserMismatch);

  const dependencies = {
    effect: host("effect", "4.0.0-rc.115"),
    "effect-agent": host("effect-agent", frameworkVersion),
    ...Object.fromEntries(
      receipt.packages.map((entry) => [entry.name, `file:${join(out, entry.filename)}`]),
    ),
  };

  const incompatibleFramework = host("effect-agent", "0.1.0-beta.103");

  for (const { name, replacements } of [
    { name: "matching", replacements: {} },
    { name: "effect-browser", replacements: { "effect-browser": incompatibleBrowser } },
    { name: "effect-agent", replacements: { "effect-agent": incompatibleFramework } },
  ]) {
    const directory = join(out, `direct-${name}`);

    mkdirSync(directory);
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: "direct-peer-fixture",
        private: true,
        type: "module",
        dependencies: { ...dependencies, ...replacements },
      }),
    );

    const result = childProcess.spawnSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--legacy-peer-deps=false",
        "--force=false",
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          npm_config_cache: join(out, "npm-cache"),
          npm_config_userconfig: join(out, "fixture.npmrc"),
        },
      },
    );

    assert.equal(result.error, undefined);
    const output = (result.stdout ?? "") + (result.stderr ?? "");

    if (name === "matching") {
      assert.equal(result.status, 0, output);
      const require = createRequire(join(directory, "package.json"));

      for (const [dependent, peer] of [
        ["effect-browserbase", "effect-browser"],
        ["effect-agent-browser", "effect-browser"],
        ["effect-agent-browser", "effect-agent"],
      ]) {
        const dependentRequire = createRequire(require.resolve(dependent));

        assert.equal(
          realpathSync(dependentRequire.resolve(peer)),
          realpathSync(require.resolve(peer)),
          `${dependent} must use the directly supplied ${peer}`,
        );
      }
    } else {
      assert.notEqual(
        result.status,
        0,
        "An incompatible direct host must fail strict peer resolution",
      );
      assert.match(output, /ERESOLVE/);
      assert.ok(output.includes(`peer ${name}@"${versions[name]}"`), output);
    }
  }
});

test("missing, reordered, extra or mixed-version receipt entries fail even with a supplied matching receipt digest", (t) => {
  const { tree, out } = workspace(t),
    receipt = packageReleaseSet(tree, out, sha);

  for (const entries of [
    [receipt.packages[0]],
    [...receipt.packages].reverse(),
    [...receipt.packages, receipt.packages[0]],
    receipt.packages.map((entry, index) =>
      index === 2 ? { ...entry, version: "0.2.0-beta.1" } : entry,
    ),
  ]) {
    writeFileSync(join(out, "release-set.json"), JSON.stringify({ ...receipt, packages: entries }));
    assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, releaseSetDigest(out)));
  }
});

test("transitive generic declarations may not import the optional native or framework types", (t) => {
  const { tree, out } = workspace(t, (tree) =>
    writeFileSync(
      join(tree, packages[0].directory, "dist/Hidden.d.mts"),
      'export type { Page } from "playwright-core";\n',
    ),
  );

  packageReleaseSet(tree, out, sha);
  assert.throws(
    () => verifyReleaseSet(out, sha, `v${version}`, releaseSetDigest(out)),
    /Generic declaration imports/,
  );
});

test("the retired publisher refuses live execution before any artifact or command access", () => {
  let called = false;

  assert.throws(
    () =>
      publishReleaseSet("/nonexistent-release", sha, `v${version}`, "0".repeat(64), {
        publish: true,
        run: () => {
          called = true;
        },
      }),
    /Live publication requires.*journal/,
  );
  assert.equal(called, false);
});

test("acceptance retains dependency-ordered lifecycle-free npm dry-runs", (t) => {
  const { tree, out } = workspace(t),
    receipt = packageReleaseSet(tree, out, sha),
    digest = releaseSetDigest(out);

  const calls = [];

  const results = publishReleaseSet(out, sha, `v${version}`, digest, {
    run: (args) => {
      calls.push(args);

      return "{}";
    },
  });

  assert.deepEqual(
    results.map((result) => result.state),
    ["dry-run", "dry-run", "dry-run"],
  );
  assert.deepEqual(
    calls.map((args) => args[1]),
    receipt.packages.map((entry) => join(out, entry.filename)),
  );
  assert.ok(
    calls.every(
      (args) =>
        args[0] === "publish" &&
        args.includes("--dry-run") &&
        args.includes("--ignore-scripts") &&
        args.includes("--provenance=false"),
    ),
  );
  assert.deepEqual(
    readFileSync(join(out, "publication-dry-run.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse),
    results,
  );
});

for (const declarationExit of [0, 1]) {
  test(`packed consumer receipts retain the raw declaration exit ${declarationExit}`, (t) => {
    const { tree, out } = workspace(t, (tree) => {
      writeFileSync(
        join(tree, "package.json"),
        JSON.stringify({
          catalog: {
            effect: "4.0.0-rc.115",
            "@types/node": "26.1.2",
            typescript: "7.0.2",
            "vite-plus": "0.3.2",
            "playwright-core": "1.63.0",
            "@effect/vitest": "4.0.0-rc.115",
            "@effect/platform-node": "4.0.0-rc.115",
            vitest: "4.1.11",
          },
        }),
      );
      for (const item of packages) {
        const pkg = join(tree, item.directory);

        const files = [
          "test/consumer/resources.ts",
          "test/consumer/native.ts",
          "test/consumer/agent.ts",
          "test/consumer/chromium.ts",
          "test/native/fixture.test.ts",
          "examples/fixture.ts",
          "vite.native.config.ts",
        ];

        if (item === packages[2])
          files.push(
            "test/native/adapter.test.ts",
            "test/native/chromium-tools.test.ts",
            "examples/chromium.ts",
          );
        // Only the generic package carries the hosted checks that the generic consumer compiles.
        if (item === packages[1]) files.push("hosted/fixture.ts");
        for (const file of files) {
          const target = join(pkg, file);

          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, "export {};\n");
        }
      }
    });

    const diagnostic =
      "node_modules/effect-agent/dist/capabilities/MemoryNotes.d.mts(330,108): error TS2304: Cannot find name 'S'.\n";

    // Only the external command boundary is substituted. Real packing, fixture staging,
    // strict configuration and receipt aggregation run; no installs or browsers run here.
    const commands = t.mock.method(childProcess, "spawnSync", (_command, args, options) => {
      const failing =
        options.cwd === join(out, "consumers/agent") &&
        args[0] === "exec" &&
        args[1] === join(options.cwd, "node_modules/.bin/tsc") &&
        args[2] === "--noEmit" &&
        args[3] === "--project" &&
        args[4] === join(options.cwd, "tsconfig.json");

      return {
        status: failing ? declarationExit : 0,
        signal: null,
        stdout: failing && declarationExit !== 0 ? diagnostic : "",
        stderr: "",
      };
    });

    syncBuiltinESMExports();
    t.after(() => {
      commands.mock.restore();
      syncBuiltinESMExports();
    });
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});

    if (declarationExit === 0) packedConsumers(tree, out, sha);
    else
      assert.throws(
        () => packedConsumers(tree, out, sha),
        /One or more canonical consumer gates failed/,
      );

    const records = readFileSync(join(out, "consumer-statuses.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.deepEqual(
      records.filter((record) => record.step === "declarations"),
      [
        { profile: "resources", step: "declarations", exitCode: 0, signal: null, passed: true },
        { profile: "browser", step: "declarations", exitCode: 0, signal: null, passed: true },
        { profile: "generic", step: "declarations", exitCode: 0, signal: null, passed: true },
        {
          profile: "agent",
          step: "declarations",
          exitCode: declarationExit,
          signal: null,
          passed: declarationExit === 0,
        },
        { profile: "agent-hosted", step: "declarations", exitCode: 0, signal: null, passed: true },
      ],
    );

    const staged = (profile) =>
      JSON.parse(readFileSync(join(out, "consumers", profile, "staged-files.json"), "utf8"));

    for (const profile of ["browser", "agent"]) {
      assert.ok(
        staged(profile).every((file) => !file.startsWith(packages[1].directory + "/")),
        `${profile} unexpectedly stages provider examples or fixtures`,
      );
    }

    const nativeAgent = staged("agent").filter(
      (file) => file.includes("/native/") && file.endsWith(".test.ts"),
    );

    const hostedAgent = staged("agent-hosted").filter(
      (file) => file.includes("/native/") && file.endsWith(".test.ts"),
    );

    assert.equal(
      new Set([...nativeAgent, ...hostedAgent]).size,
      nativeAgent.length + hostedAgent.length,
    );
    assert.equal(nativeAgent.length + hostedAgent.length, 3);
    assert.equal(
      records.every((record) => record.passed),
      declarationExit === 0,
    );
    assert.equal(
      readFileSync(join(out, "consumer-agent-declarations.log"), "utf8"),
      declarationExit === 0 ? "" : diagnostic,
    );
    assert.equal(records.filter((record) => record.step.endsWith("-workflow")).length, 10);
    for (const profile of consumerProfiles) {
      const config = JSON.parse(
        readFileSync(join(out, "consumers", profile, "tsconfig.json"), "utf8"),
      );

      assert.equal(config.compilerOptions.strict, true);
      assert.equal(config.compilerOptions.skipLibCheck, false);
    }
  });
}

test("generic and Agent boundaries reject provider and framework declaration leaks", (t) => {
  for (const [index, dependency, message] of [
    [0, "effect-browserbase", /Neutral declaration imports/],
    [1, "effect-agent", /Generic declaration imports/],
    [2, "effect-browserbase", /Agent declaration imports/],
  ]) {
    const { tree, out } = workspace(t, (tree) =>
      writeFileSync(
        join(tree, packages[index].directory, "dist/Hidden.d.mts"),
        `export type { Hidden } from "${dependency}";\n`,
      ),
    );

    packageReleaseSet(tree, out, sha);
    assert.throws(() => verifyReleaseSet(out, sha, `v${version}`, releaseSetDigest(out)), message);
  }
});
