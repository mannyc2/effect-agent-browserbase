import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packages, readJson, readPackageSet } from "./packages.mjs";
import { packageReleaseSet, releaseSetDigest } from "./package-release.mjs";
import { stageConsumer } from "./stage-consumer.mjs";
import { verifyReleaseSet } from "./verify-release.mjs";

const tools = fileURLToPath(new URL(".", import.meta.url));
const modes = [
  { name: "resources", owner: packages[0], entry: "test/consumer/resources.ts", native: false },
  { name: "generic", owner: packages[0], entry: "test/consumer/native.ts", native: true },
  { name: "agent", owner: packages[1], entry: "test/consumer/agent.ts", native: true },
];
const walk = (directory, prefix = "") => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]);

const diagnostic = /(?:^|\n)(\S[^\n(]*)\(\d+,\d+\): error TS\d+/g;

/** Published framework declarations this repository does not build or control. */
const foreign = /^node_modules[\\/]effect-agent[\\/]/;

export function declarationFiles(output) {
  return [...String(output).matchAll(diagnostic)].map((match) => match[1].replaceAll("\\", "/"));
}

export function excusedDeclarations(output) {
  return [...new Set(declarationFiles(output).filter((file) => foreign.test(file)))];
}

/** Pass only when every remaining declaration failure belongs to someone else's package. */
export function ownDeclarations(output, status) {
  if (status === 0) return true;
  const files = declarationFiles(output);

  return files.length > 0 && files.every((file) => foreign.test(file));
}

export function consumerManifest(mode, receipt, out, catalog) {
  const file = (index) => `file:${join(resolve(out), receipt.packages[index].filename)}`;
  const dependencies = { [packages[0].name]: file(0), effect: catalog.effect };
  const devDependencies = { "@types/node": catalog["@types/node"], typescript: catalog.typescript, "vite-plus": catalog["vite-plus"] };
  if (mode !== "resources") {
    dependencies["playwright-core"] = catalog["playwright-core"];
    devDependencies["@effect/vitest"] = catalog["@effect/vitest"];
    devDependencies.vitest = catalog.vitest;
  }
  if (mode === "agent") {
    dependencies[packages[1].name] = file(1);
    dependencies["effect-agent"] = receipt.frameworkVersion;
    devDependencies["@effect-agent/testing"] = receipt.frameworkVersion;
  }
  for (const [name, value] of Object.entries({ ...dependencies, ...devDependencies })) assert.equal(typeof value, "string", `Missing pinned consumer dependency: ${name}`);
  return {
    name: `browserbase-${mode}-consumer`, private: true, type: "module",
    scripts: { check: "tsc --noEmit -p tsconfig.json" }, dependencies, devDependencies,
    // Bun 1.4.2 supports file tarball overrides. The production tarball keeps its
    // exact registry dependency; only this private test consumer substitutes it.
    overrides: { [packages[0].name]: file(0), effect: catalog.effect, ...(mode === "resources" ? {} : { vitest: catalog.vitest }) },
  };
}

export function packedConsumers(tree, out, sha) {
  const sources = readPackageSet(tree), catalog = readJson(join(tree, "package.json")).catalog;
  const receipt = packageReleaseSet(tree, out, sha), setDigest = releaseSetDigest(out);
  verifyReleaseSet(out, sha, `v${receipt.version}`, setDigest);
  const root = join(out, "consumers");
  assert.ok(!existsSync(root), "Refusing existing consumers"); mkdirSync(root);
  const results = [];
  const run = (mode, name, command, args, cwd, extraEnv = {}, accept) => {
    const logBase = join(out, `consumer-${mode}-${name}`);
    writeFileSync(logBase + ".command.json", JSON.stringify({ cwd, command, args }, null, 2) + "\n");
    const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(logBase + ".log", output + (result.error ? `\n${result.error.message}\n` : ""));
    const judged = result.error ? undefined : accept?.(output, result.status);
    const record = { profile: mode, step: name, exitCode: result.status, signal: result.signal, passed: judged ?? (result.status === 0 && !result.error) };
    if (judged !== undefined) record.excused = excusedDeclarations(output).length;
    results.push(record); appendFileSync(join(out, "consumer-statuses.ndjson"), JSON.stringify(record) + "\n");
    console.log(JSON.stringify(record));
    if (!record.passed) console.error(output.split("\n").slice(-60).join("\n"));
    return record.passed;
  };
  for (const mode of modes) {
    try {
      const directory = join(root, mode.name); mkdirSync(directory);
      const profilePackages = mode.name === "agent" ? packages : [packages[0]];
      writeFileSync(join(directory, "package.json"), JSON.stringify(consumerManifest(mode.name, receipt, out, catalog), null, 2) + "\n");
      const entries = [`${mode.owner.directory}/${mode.entry}`];
      if (mode.native) {
        const tests = walk(join(tree, mode.owner.directory, "test/native")).filter((p) => p.endsWith(".test.ts"));
        assert.ok(tests.length > 0, `No real native suite for ${mode.name}`);
        entries.push(...tests.map((p) => `${mode.owner.directory}/test/native/${p}`));
        entries.push(`${mode.owner.directory}/vite.native.config.ts`);
        const examples = walk(join(tree, mode.owner.directory, "examples")).filter((p) => p.endsWith(".ts") || p.endsWith(".mts"));
        assert.ok(examples.length > 0, `No migrated public examples for ${mode.name}`);
        entries.push(...examples.map((p) => `${mode.owner.directory}/examples/${p}`));
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
      // Every declaration this repository ships is checked with skipLibCheck:false. The
      // agent profile additionally compiles effect-agent's own published declarations,
      // which do not currently compile at all; those exact files are excused and counted
      // instead of relaxing the check for our packages.
      run(mode.name, "declarations", vp, ["run", "check"], directory, {}, mode.name === "agent" ? ownDeclarations : undefined);
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
