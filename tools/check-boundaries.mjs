import { spawnSync } from "node:child_process";
// The kernel must survive feature deletion, and features must use its public contracts.
import { readFile, readdir, stat, mkdtemp, cp, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";

import { parseSync } from "vite/rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "packages/browser/src");
const sharedTests = join(root, "tools/testing");
const within = (directory, target) => {
  const path = relative(directory, target);

  return path !== ".." && !path.startsWith("../");
};
const featureNames = new Set([
  "moment",
  "plan",
  "policy",
  "presentation",
  "stillness",
  "supervisor",
  "providers",
  "testing",
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
const errors = [];
// Test services share exactly the ownership algorithms they contract-test; runtime features get no exception.
const testingPlumbing = new Set([
  "internal/input/gate.ts",
  "internal/page/lane.ts",
  "internal/timeline/events.ts",
  "internal/timeline/fold.inpage.ts",
]);
const manifest = JSON.parse(await readFile(join(root, "packages/browser/package.json"), "utf8"));
const sourcesOf = (entry) =>
  typeof entry === "string"
    ? entry.startsWith("./src/")
      ? [resolve(root, "packages/browser", entry)]
      : []
    : Object.values(entry ?? {}).flatMap(sourcesOf);
const sourceOf = (entry) => sourcesOf(entry?.["@effect-browser/source"] ?? entry)[0];
const entries = new Map(
  Object.entries(manifest.exports).map(([name, entry]) => [
    name === "." ? "effect-browser" : `effect-browser/${name.slice(2)}`,
    sourceOf(entry),
  ]),
);
const publicSources = new Set(Object.values(manifest.exports).flatMap(sourcesOf));
const kernelEntries = new Set(sourcesOf(manifest.exports["."]));
// An alternate provider entry has its provider's ownership; other Workers modules are kernel.
const facadeOwners = new Map(
  Object.entries(manifest.exports).flatMap(([name, entry]) =>
    name === "."
      ? []
      : sourcesOf(entry)
          .filter((file) => relative(source, file).startsWith("workerd/"))
          .map((file) => [file, relative(source, sourceOf(entry)).split("/")[0]]),
  ),
);
const ownerOf = (file) => facadeOwners.get(file) ?? relative(source, file).split("/")[0];
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
const sharedLibrary = {
  directory: sharedTests,
  manifest: rootManifest,
  declared: new Set(rootDependencies),
  testDeclared: new Set([...rootDependencies, ...workspace.keys()]),
  sources: [],
  tests: await files(sharedTests),
};
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const references = (file, text, testing) => {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    let specifier;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
        "TSImportType",
      ].includes(node.type)
    )
      specifier = node.source;
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
        found.push(specifier.value);
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

for (const library of [...libraries, sharedLibrary])
  for (const [file, testing] of [
    ...library.sources.map((file) => [file, false]),
    ...library.tests.map((file) => [file, true]),
  ]) {
    const owner = ownerOf(file);
    const text = await readFile(file, "utf8");
    for (const specifier of references(file, text, testing)) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!within(library.directory, target) && !(testing && within(sharedTests, target)))
          errors.push(`${relative(root, file)}: relative import leaves its package ${specifier}`);
      } else if (isBuiltin(specifier)) {
        if (
          !testing &&
          library.manifest.name === "effect-browser" &&
          relative(source, file).split("/")[0] !== "providers"
        )
          errors.push(`${relative(root, file)}: Node builtin outside a Node provider ${specifier}`);
      } else {
        const dependency = packageOf(specifier);
        const declared = testing ? library.testDeclared : library.declared;
        if (dependency !== library.manifest.name && !declared.has(dependency))
          errors.push(
            `${relative(root, file)}: undeclared ${testing ? "test" : "runtime"} dependency ${dependency}`,
          );
        const sibling = workspace.get(dependency);
        if (sibling) {
          const entry = specifier === dependency ? "." : `.${specifier.slice(dependency.length)}`;
          if (!Object.hasOwn(sibling.manifest.exports, entry))
            errors.push(`${relative(root, file)}: unexported package subpath ${specifier}`);
        }
      }
      if (testing || library.manifest.name !== "effect-browser") continue;
      if (specifier.startsWith("effect-browser/") && !entries.has(specifier)) {
        errors.push(`${relative(root, file)}: unexported package subpath ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".") && !entries.has(specifier)) continue;
      const target = specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : entries.get(specifier);
      if (!target) {
        errors.push(`${relative(root, file)}: no source entry for ${specifier}`);
        continue;
      }
      const path = relative(source, target);
      const targetOwner = ownerOf(target);
      if (!featureNames.has(owner) && featureNames.has(targetOwner))
        errors.push(`${relative(root, file)}: kernel imports feature ${specifier}`);
      if (
        featureNames.has(owner) &&
        path.startsWith("internal/") &&
        !(owner === "testing" && testingPlumbing.has(path))
      )
        errors.push(`${relative(root, file)}: feature imports private kernel ${specifier}`);
      if (
        featureNames.has(owner) &&
        owner !== targetOwner &&
        !publicSources.has(target) &&
        !(owner === "testing" && testingPlumbing.has(path))
      )
        errors.push(`${relative(root, file)}: feature imports unpublished module ${specifier}`);
      try {
        await stat(target);
      } catch {
        errors.push(`${relative(root, file)}: unresolved ${specifier}`);
      }
    }
  }
if (errors.length) throw new Error(errors.join("\n"));
// Physically omit all features and providers, then typecheck every conditional kernel entry.
const work = await mkdtemp(join(tmpdir(), "effect-browser-kernel-"));
try {
  await cp(source, join(work, "src"), {
    recursive: true,
    filter: (path) =>
      !featureNames.has(relative(source, path).split("/")[0]) && !facadeOwners.has(path),
  });
  await import("node:fs/promises").then(({ symlink }) =>
    symlink(join(root, "node_modules"), join(work, "node_modules"), "dir"),
  );
  const config = JSON.parse(await readFile(join(root, "packages/browser/tsconfig.json"), "utf8"));
  config.extends = join(root, "tsconfig.base.json");
  config.include = [...kernelEntries].map((file) => `src/${relative(source, file)}`);
  delete config.exclude;
  await writeFile(join(work, "tsconfig.json"), JSON.stringify(config));
  const checked = spawnSync(
    join(root, "node_modules/.bin/tsc"),
    ["--noEmit", "-p", join(work, "tsconfig.json")],
    { encoding: "utf8" },
  );
  if (checked.status !== 0) throw new Error(checked.stdout + checked.stderr);
  console.log(
    `Checked ${libraries.reduce((count, library) => count + library.sources.length, 0)} source, ${libraries.reduce((count, library) => count + library.tests.length, 0)} package test and ${sharedLibrary.tests.length} shared test modules; the kernel typechecks with all features and providers deleted.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
