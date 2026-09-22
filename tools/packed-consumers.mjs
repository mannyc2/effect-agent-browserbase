import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { consumerPackageSet, packages, readJson, readPackageSet } from "./packages.mjs";
import { packageReleaseSet, releaseSetDigest } from "./package-release.mjs";
import { stageConsumer } from "./stage-consumer.mjs";
import { verifyReleaseSet } from "./verify-release.mjs";

const tools = fileURLToPath(new URL(".", import.meta.url));
const modes = [
  { name: "resources", owner: packages[1], entry: "test/consumer/resources.ts", native: false },
  { name: "browser", owner: packages[0], entry: "test/consumer/chromium.ts", native: true },
  { name: "generic", owner: packages[1], entry: "test/consumer/native.ts", native: true },
  { name: "agent", owner: packages[2], entry: "test/consumer/chromium.ts", native: true },
  { name: "agent-hosted", owner: packages[2], entry: "test/consumer/agent.ts", native: true },
];
const walk = (directory, prefix = "") => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);
const chromiumAgentFiles = {
  native: ["adapter.test.ts", "chromium-tools.test.ts"],
  examples: ["chromium.ts"],
};
// Partition only the shared adapter's fixtures. Every remaining maintained file
// is retained by the hosted composition, including new files added in the future.
function selectFiles(mode, kind, files) {
  if (mode.owner !== packages[2]) return files;
  for (const file of chromiumAgentFiles[kind]) assert.ok(files.includes(file), `Missing provider-free Agent ${kind}: ${file}`);
  return files.filter((file) => chromiumAgentFiles[kind].includes(file) === (mode.name === "agent"));
}

export function consumerManifest(mode, receipt, out, catalog) {
  const profilePackages = consumerPackageSet(mode);
  const file = (item) => {
    const entry = receipt.packages.find((entry) => entry.name === item.name);
    assert.ok(entry, `Missing candidate ${item.name}`);
    return `file:${join(resolve(out), entry.filename)}`;
  };
  const dependencies = { effect: catalog.effect };
  const devDependencies = { "@types/node": catalog["@types/node"], typescript: catalog.typescript, "vite-plus": catalog["vite-plus"] };
  for (const item of profilePackages) {
    // Browserbase is independently installed only for this integration profile.
    const target = mode === "agent-hosted" && item === packages[1] ? devDependencies : dependencies;
    target[item.name] = file(item);
  }
  if (mode !== "resources") {
    dependencies["playwright-core"] = catalog["playwright-core"];
    devDependencies["@effect/vitest"] = catalog["@effect/vitest"];
    devDependencies.vitest = catalog.vitest;
  }
  // The generic consumer compiles and runs every example; realistic-footage spawns its encoder
  // and serves its stage through Effect's Node platform services.
  if (mode === "generic" || mode === "browser") devDependencies["@effect/platform-node"] = catalog["@effect/platform-node"];
  if (mode.startsWith("agent")) {
    dependencies["effect-agent"] = receipt.frameworkVersion;
    devDependencies["@effect-agent/testing"] = receipt.frameworkVersion;
  }
  for (const [name, value] of Object.entries({ ...dependencies, ...devDependencies })) assert.equal(typeof value, "string", `Missing pinned consumer dependency: ${name}`);
  return {
    name: `browserbase-${mode}-consumer`, private: true, type: "module",
    scripts: { check: "tsc --noEmit -p tsconfig.json" }, dependencies, devDependencies,
    // Bun 1.4.2 supports file tarball overrides. The production tarball keeps its
    // exact registry dependency; only this private test consumer substitutes it.
    overrides: { ...Object.fromEntries(profilePackages.map((item) => [item.name, file(item)])), effect: catalog.effect, ...(mode === "resources" ? {} : { vitest: catalog.vitest }) },
  };
}

export function packedConsumers(tree, out, sha) {
  const sources = readPackageSet(tree), catalog = readJson(join(tree, "package.json")).catalog;
  const receipt = packageReleaseSet(tree, out, sha), setDigest = releaseSetDigest(out);
  verifyReleaseSet(out, sha, `v${receipt.version}`, setDigest);
  const root = join(out, "consumers");
  assert.ok(!existsSync(root), "Refusing existing consumers"); mkdirSync(root);
  const results = [];
  const run = (mode, name, command, args, cwd, extraEnv = {}) => {
    const logBase = join(out, `consumer-${mode}-${name}`);
    writeFileSync(logBase + ".command.json", JSON.stringify({ cwd, command, args }, null, 2) + "\n");
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(logBase + ".log", output + (result.error ? `\n${result.error.message}\n` : ""));
    const record = { profile: mode, step: name, exitCode: result.status, signal: result.signal, passed: result.status === 0 && !result.error };
    results.push(record); appendFileSync(join(out, "consumer-statuses.ndjson"), JSON.stringify(record) + "\n");
    console.log(JSON.stringify(record));
    if (!record.passed) console.error(output.split("\n").slice(-60).join("\n"));
    return record.passed;
  };
  for (const mode of modes) {
    try {
      const directory = join(root, mode.name); mkdirSync(directory);
      const profilePackages = consumerPackageSet(mode.name);
      writeFileSync(join(directory, "package.json"), JSON.stringify(consumerManifest(mode.name, receipt, out, catalog), null, 2) + "\n");
      const entries = [`${mode.owner.directory}/${mode.entry}`];
      if (mode.native) {
        const tests = selectFiles(mode, "native", walk(join(tree, mode.owner.directory, "test/native")).filter((p) => p.endsWith(".test.ts")));
        assert.ok(tests.length > 0, `No real native suite for ${mode.name}`);
        entries.push(...tests.map((p) => `${mode.owner.directory}/test/native/${p}`));
        entries.push(`${mode.owner.directory}/vite.native.config.ts`);
        const examples = selectFiles(mode, "examples", walk(join(tree, mode.owner.directory, "examples")).filter((p) => p.endsWith(".ts") || p.endsWith(".mts")));
        assert.ok(examples.length > 0, `No migrated public examples for ${mode.name}`);
        entries.push(...examples.map((p) => `${mode.owner.directory}/examples/${p}`));
        if (mode.owner === packages[1]) {
          // The paid hosted checks compile against the packed package here; nothing runs them.
          const hosted = walk(join(tree, mode.owner.directory, "hosted")).filter((p) => p.endsWith(".ts"));
          assert.ok(hosted.length > 0, "No hosted checks to compile");
          entries.push(...hosted.map((p) => `${mode.owner.directory}/hosted/${p}`));
        }
      }
      const files = stageConsumer(tree, join(directory, "fixtures"), entries);
      writeFileSync(join(directory, "staged-files.json"), JSON.stringify(files, null, 2) + "\n");
      const exports = profilePackages.flatMap((item) => Object.keys(sources.find((s) => s.name === item.name).exports).map((key) => item.name + (key === "." ? "" : key.slice(1))));
      writeFileSync(join(directory, "exports.mts"), exports.map((name, i) => `export * as Entry${i} from ${JSON.stringify(name)};`).join("\n") + "\n");
      writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: {
        target: "ES2023", lib: ["ES2023", "DOM", "DOM.Iterable"], module: "NodeNext", moduleResolution: "NodeNext", allowImportingTsExtensions: true, resolveJsonModule: true,
        noEmit: true, strict: true, noUnusedLocals: true, noUnusedParameters: true, skipLibCheck: false, types: ["node"],
      }, include: ["exports.mts", "fixtures/**/*.ts", "fixtures/**/*.mts"] }, null, 2) + "\n");
      if (!run(mode.name, "install", "bun", ["install", "--ignore-scripts"], directory)) continue;
      const vp = join(directory, "node_modules/.bin/vp");
      if (!run(mode.name, "frozen-install", vp, ["install", "--frozen-lockfile", "--ignore-scripts"], directory)) continue;
      // All five consumers check reachable published declarations with skipLibCheck:false.
      // A dependency diagnostic fails the gate just as a diagnostic in a candidate does.
      run(mode.name, "declarations", vp, ["run", "check"], directory);
      for (const runtime of ["node", "bun"]) {
        if (!run(mode.name, `${runtime}-identity`, runtime, [join(tools, "verify-consumer.mjs"), directory, out, mode.name], directory)) continue;
        const evidence = join(out, `video-${mode.name}-${runtime}`); mkdirSync(evidence);
        run(mode.name, `${runtime}-workflow`, runtime, [join(directory, "fixtures", mode.owner.directory, mode.entry)], directory, { BROWSERBASE_VIDEO_EVIDENCE_DIR: evidence });
      }
      if (mode.native) {
        const cwd = join(directory, "fixtures", mode.owner.directory);
        const evidence = join(out, `video-${mode.name}-suite`); mkdirSync(evidence);
        run(mode.name, "native", vp, ["test", "--config", "vite.native.config.ts", "--run"], cwd, { BROWSERBASE_VIDEO_EVIDENCE_DIR: evidence });
      }
      // Installation and test commands must not change the candidate archive.
      verifyReleaseSet(out, sha, `v${receipt.version}`, setDigest);
    } catch (error) {
      const record = { profile: mode.name, step: "setup-or-final-identity", passed: false, message: String(error) };
      results.push(record); appendFileSync(join(out, "consumer-statuses.ndjson"), JSON.stringify(record) + "\n"); console.error(record);
    }
  }
  assert.ok(results.length > 0 && results.every((r) => r.passed), "One or more canonical consumer gates failed; inspect consumer-statuses.ndjson and logs");
  return { sourceSha: sha, releaseSetSha256: setDigest, profiles: modes.map((m) => m.name), results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tree, out, sha] = process.argv.slice(2);
  assert.ok(tree && out && sha, "Usage: node tools/packed-consumers.mjs WORKSPACE OUT SOURCE_SHA");
  console.log(JSON.stringify(packedConsumers(resolve(tree), resolve(out), sha)));
}
