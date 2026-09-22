import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { consumerPackageSet, readJson } from "./packages.mjs";

export async function verifyDeclarationExports(tree, consumer, profile) {
  tree = resolve(tree);
  consumer = resolve(consumer);
  const consumerManifest = readJson(join(consumer, "package.json"));
  const consumerRequire = createRequire(join(consumer, "package.json"));
  const compiler = consumerRequire("typescript/package.json");
  assert.equal(compiler.version, consumerManifest.devDependencies?.typescript, "Consumer TypeScript does not match its pinned dependency");
  assert.match(compiler.version, /^7\./, "Declaration export parity requires the pinned TypeScript 7 compiler");
  const { API } = await import(pathToFileURL(consumerRequire.resolve("typescript/unstable/sync")).href);

  const entries = consumerPackageSet(profile).flatMap((item) => {
    const sourceManifest = readJson(join(tree, item.directory, "package.json"));
    const runtime = consumerRequire.resolve(item.name);
    const packageRoot = dirname(dirname(runtime));
    const installedManifest = readJson(join(packageRoot, "package.json"));
    assert.equal(installedManifest.name, item.name, `Installed package identity drifted for ${item.name}`);
    assert.deepEqual(Object.keys(installedManifest.exports).toSorted(), Object.keys(sourceManifest.exports).toSorted(), `${item.name} export paths drifted`);
    return Object.entries(sourceManifest.exports).map(([key, sourceTarget]) => {
      const installedTarget = installedManifest.exports[key]?.types;
      assert.equal(typeof installedTarget, "string", `${item.name}${key === "." ? "" : key.slice(1)} is missing its declaration entry`);
      return {
        specifier: item.name + (key === "." ? "" : key.slice(1)),
        source: join(tree, item.directory, sourceTarget.slice(2)),
        declaration: join(packageRoot, installedTarget.slice(2)),
      };
    });
  });

  const config = join(consumer, "declaration-exports.tsconfig.json");
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2023",
      lib: ["ES2023", "ESNext.Disposable", "DOM", "DOM.Iterable"],
      types: [],
      allowImportingTsExtensions: true,
    },
    files: entries.flatMap((entry) => [entry.source, entry.declaration]),
  }, null, 2) + "\n");

  const api = new API({ cwd: tree });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    assert.ok(project, "Pinned TypeScript did not open the declaration export project");
    const names = (path) => {
      const source = project.program.getSourceFile(path);
      assert.ok(source, `Pinned TypeScript did not load ${basename(path)}`);
      const symbol = project.checker.getSymbolAtLocation(source);
      assert.ok(symbol, `Pinned TypeScript did not bind ${basename(path)}`);
      return [...symbol.getExports().values()].map((value) => value.name).sort();
    };
    for (const entry of entries) {
      assert.deepEqual(names(entry.declaration), names(entry.source), `${entry.specifier} declaration export drift`);
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }

  return { profile, compiler: compiler.version, entries: entries.length, result: "installed declaration exports match source entries" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tree, consumer, profile] = process.argv.slice(2);
  assert.ok(tree && consumer && profile, "Usage: node tools/verify-declaration-exports.mjs TREE CONSUMER PROFILE");
  console.log(JSON.stringify(await verifyDeclarationExports(tree, consumer, profile)));
}
