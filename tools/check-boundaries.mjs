import { spawn } from "node:child_process";
// The core must survive deleting each feature, features use its public modules and the internals
// it shares with them, and its root loads only `effect`.
import { cp, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

import { parseSync } from "vite/rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const core = join(root, "packages/browser");
const source = join(core, "src");
const sharedTests = join(root, "tools/testing");
const within = (directory, target) => {
  const path = relative(directory, target);

  return path !== ".." && !path.startsWith("../");
};
// Each feature folder is a subpath of its own, and can be deleted with the features that import it.
const featureNames = new Set([
  "ai",
  "policy",
  "presentation",
  "supervisor",
  "testing",
  "timeline",
  "walk",
]);
// Inside effect-browser modules share internals; these are the ones features may import.
const sharedInternals = new Set([
  "internal/action-port.ts",
  "internal/clock.ts",
  "internal/geometry.ts",
  "internal/matching.ts",
  "internal/url.ts",
]);
// Test services share exactly the ownership algorithms they contract-test; runtime features get no exception.
const testingPlumbing = new Set([
  "internal/input/gate.ts",
  "internal/page/lane.ts",
  "internal/timeline/events.ts",
  "internal/timeline/fold.inpage.ts",
]);
const files = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : /\.(?:[cm]?[jt]sx?)$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      ),
    )
  ).flat();
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const errors = [];

// Node's resolution of a subpath through a package's exports: the exact key, else the pattern
// with the longest prefix. Null closes a path.
const exported = (exports, subpath) => {
  if (Object.hasOwn(exports, subpath)) return exports[subpath];
  let best;
  for (const key of Object.keys(exports)) {
    const star = key.indexOf("*");
    if (star < 0 || key.lastIndexOf("*") !== star) continue;
    const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best ||
        prefix.length > best.prefix.length ||
        (prefix.length === best.prefix.length && key.length > best.key.length))
    )
      best = { key, prefix, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  if (!best) return undefined;
  const fill = (value) =>
    typeof value === "string"
      ? value.replaceAll("*", best.match)
      : value &&
        Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, fill(inner)]));
  return fill(exports[best.key]);
};
const sourcesOf = (entry, directory) =>
  typeof entry === "string"
    ? entry.startsWith("./src/")
      ? [resolve(directory, entry)]
      : []
    : Object.values(entry ?? {}).flatMap((inner) => sourcesOf(inner, directory));
// The source files a package subpath reaches, under every condition; none when it is closed.
const reached = (library, subpath) =>
  sourcesOf(exported(library.manifest.exports, subpath), library.directory);

const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const rootDependencies = Object.keys({
  ...rootManifest.dependencies,
  ...rootManifest.optionalDependencies,
  ...rootManifest.peerDependencies,
  ...rootManifest.devDependencies,
});
const libraries = await Promise.all(
  (await readdir(join(root, "packages"))).map(async (name) => {
    const directory = join(root, "packages", name);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    const declared = new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      }),
    );
    if (name === "browser")
      for (const dependency of declared)
        if (!["effect", "playwright-core"].includes(dependency))
          errors.push(`effect-browser: forbidden runtime dependency ${dependency}`);
    // Yielded Agent is one binding's dependency: the core's agent tools run in any effect/ai loop.
    if (
      manifest.name !== "@effect-browser/yielded" &&
      (declared.has("@yielded/agent") || Object.hasOwn(manifest.devDependencies ?? {}, "@yielded/agent"))
    )
      errors.push(`${manifest.name}: only @effect-browser/yielded depends on @yielded/agent`);
    return {
      directory,
      manifest,
      declared,
      testDeclared: new Set([
        ...declared,
        ...Object.keys(manifest.devDependencies ?? {}),
        ...rootDependencies,
      ]),
      sources: await files(join(directory, "src")),
      tests: await files(join(directory, "test")),
    };
  }),
);
const workspace = new Map(libraries.map((library) => [library.manifest.name, library]));
const coreLibrary = workspace.get("effect-browser");
const sharedLibrary = {
  directory: sharedTests,
  manifest: rootManifest,
  declared: new Set(rootDependencies),
  testDeclared: new Set([...rootDependencies, ...workspace.keys()]),
  sources: [],
  tests: await files(sharedTests),
};
// A core file is public when the subpath its path names reaches it, or an explicit entry does.
const subpathOf = (file) => {
  const path = relative(source, file).replace(/\.[cm]?[jt]sx?$/, "");

  return path === "index" ? "." : `./${path.replace(/\/index$/, "")}`;
};
const publicSources = new Set([
  ...Object.entries(coreLibrary.manifest.exports)
    .filter(([key]) => !key.includes("*"))
    .flatMap(([, entry]) => sourcesOf(entry, core)),
  ...coreLibrary.sources.filter((file) => reached(coreLibrary, subpathOf(file)).includes(file)),
]);
const kernelEntries = new Set(reached(coreLibrary, "."));
const ownerOf = (file) => {
  const folder = relative(source, file).split("/")[0];

  return featureNames.has(folder) ? folder : "core";
};
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const typeOnly = (node) =>
  node.importKind === "type" ||
  node.exportKind === "type" ||
  (node.specifiers?.length > 0 &&
    node.specifiers.every(
      (specifier) => (specifier.importKind ?? specifier.exportKind) === "type",
    ));
const references = (file, text, testing) => {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    let specifier;
    let types = false;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      specifier = node.source;
      types = typeOnly(node);
    }
    if (node.type === "ImportExpression") specifier = node.source;
    if (node.type === "TSImportType") {
      specifier = node.source;
      types = true;
    }
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference.type === "TSExternalModuleReference"
    )
      specifier = node.moduleReference.expression;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    )
      specifier = node.arguments[0];
    if (specifier) {
      if (
        specifier.type === "StringLiteral" ||
        (specifier.type === "Literal" && typeof specifier.value === "string")
      )
        found.push({ specifier: specifier.value, types });
      // Tests also load generated bundle URLs; their static imports still obey package exports.
      else if (!testing)
        errors.push(`${relative(root, file)}: module dependency must be a string literal`);
    }
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
  };
  visit(parseSync(file, text).program);
  return found;
};

const imported = new Map(); // a core source file's references, for its runtime closure
const featureImports = new Map([...featureNames].map((name) => [name, new Set()]));
for (const library of [...libraries, sharedLibrary])
  for (const [file, testing] of [
    ...library.sources.map((file) => [file, false]),
    ...library.tests.map((file) => [file, true]),
  ]) {
    const owner = ownerOf(file);
    const text = await readFile(file, "utf8");
    const found = references(file, text, testing);
    const inCore = !testing && library === coreLibrary;
    if (inCore) imported.set(file, found);
    for (const { specifier } of found) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!within(library.directory, target) && !(testing && within(sharedTests, target)))
          errors.push(`${relative(root, file)}: relative import leaves its package ${specifier}`);
      } else if (isBuiltin(specifier)) {
        if (inCore)
          errors.push(`${relative(root, file)}: Node builtin in effect-browser ${specifier}`);
      } else {
        const dependency = packageOf(specifier);
        const declared = testing ? library.testDeclared : library.declared;
        if (dependency !== library.manifest.name && !declared.has(dependency))
          errors.push(
            `${relative(root, file)}: undeclared ${testing ? "test" : "runtime"} dependency ${dependency}`,
          );
        const sibling = workspace.get(dependency);
        if (sibling) {
          const subpath = specifier === dependency ? "." : `.${specifier.slice(dependency.length)}`;
          const targets = reached(sibling, subpath);
          if (!targets.length || !(await exists(targets[0])))
            errors.push(`${relative(root, file)}: unexported package subpath ${specifier}`);
        }
      }
      if (!inCore) continue;
      // The core may name itself only through an export, and then obeys the same ownership.
      const target = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : packageOf(specifier) === "effect-browser"
          ? sourcesOf(
              exported(
                coreLibrary.manifest.exports,
                `.${specifier.slice("effect-browser".length)}`,
              )?.["@effect-browser/source"],
              core,
            )[0]
          : undefined;
      if (target === undefined) continue;
      const path = relative(source, target);
      const targetOwner = ownerOf(target);
      const shared =
        sharedInternals.has(path) || (owner === "testing" && testingPlumbing.has(path));
      if (!featureNames.has(owner) && featureNames.has(targetOwner))
        errors.push(`${relative(root, file)}: kernel imports feature ${specifier}`);
      if (featureNames.has(owner) && path.startsWith("internal/") && !shared)
        errors.push(`${relative(root, file)}: feature imports private kernel ${specifier}`);
      else if (
        featureNames.has(owner) &&
        owner !== targetOwner &&
        !publicSources.has(target) &&
        !shared
      )
        errors.push(`${relative(root, file)}: feature imports unpublished module ${specifier}`);
      if (featureNames.has(owner) && featureNames.has(targetOwner) && owner !== targetOwner)
        featureImports.get(owner).add(targetOwner);
      if (!(await exists(target))) errors.push(`${relative(root, file)}: unresolved ${specifier}`);
    }
  }

// What the root loads when it runs: every value import from its entries, through relative files.
const runtime = new Set();
const queue = [...kernelEntries];
for (const seen = new Set(); queue.length;) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  for (const { specifier, types } of imported.get(file) ?? [])
    if (types) continue;
    else if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
    else runtime.add(packageOf(specifier));
}
for (const dependency of runtime)
  if (dependency !== "effect")
    errors.push(`effect-browser: the root loads ${dependency} at runtime`);
if (errors.length) throw new Error(errors.join("\n"));

// Typecheck what remains of the core's source with some feature folders deleted: each feature
// with the features that import it, then every feature at once.
const importersOf = (feature) => {
  const deleted = new Set([feature]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, targets] of featureImports)
      if (!deleted.has(name) && [...targets].some((target) => deleted.has(target))) {
        deleted.add(name);
        grew = true;
      }
  }
  return deleted;
};
const config = JSON.parse(await readFile(join(core, "tsconfig.json"), "utf8"));
const typecheck = async (deleted, entries) => {
  const work = await mkdtemp(join(tmpdir(), "effect-browser-kernel-"));
  try {
    await cp(source, join(work, "src"), {
      recursive: true,
      filter: (path) => !deleted.has(relative(source, path).split("/")[0]),
    });
    await symlink(join(root, "node_modules"), join(work, "node_modules"), "dir");
    // The manifest names each module as the language service's API allowlist does.
    await cp(join(core, "package.json"), join(work, "package.json"));
    const remaining =
      entries ?? (await files(join(work, "src"))).map((file) => relative(work, file));
    await writeFile(
      join(work, "tsconfig.json"),
      JSON.stringify({
        ...config,
        extends: join(root, "tsconfig.base.json"),
        include: [...remaining],
        exclude: undefined,
      }),
    );
    const output = await new Promise((done) => {
      const child = spawn(join(root, "node_modules/.bin/tsc"), [
        "--noEmit",
        "-p",
        join(work, "tsconfig.json"),
      ]);
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.stderr.on("data", (chunk) => (text += chunk));
      child.on("close", (status) => done({ status, text }));
    });
    if (output.status !== 0)
      throw new Error(`With ${[...deleted].toSorted().join(", ")} deleted:\n${output.text}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};
const deletions = [...featureNames].toSorted().map(importersOf);
await Promise.all([
  ...deletions.map((deleted) => typecheck(deleted)),
  typecheck(
    featureNames,
    [...kernelEntries].map((file) => `src/${relative(source, file)}`),
  ),
]);
console.log(
  `Checked ${libraries.reduce((count, library) => count + library.sources.length, 0)} source, ${libraries.reduce((count, library) => count + library.tests.length, 0)} package test and ${sharedLibrary.tests.length} shared test modules; the root loads only effect, and the core typechecks with ${deletions.map((deleted) => [...deleted].join("+")).join(", ")} deleted in turn, and with every feature deleted.`,
);
