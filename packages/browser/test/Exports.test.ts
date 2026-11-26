// The exports follow Effect's layout: the root barrel, a module per file, an entry per feature
// folder's index, and closed internals, where the build also puts its shared chunks.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import * as Root from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

const source = new URL("../src/", import.meta.url);

const modules = (directory: URL) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".ts") && file !== "index.ts")
    .map((file) => file.slice(0, -3))
    .toSorted();

const folders = readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "internal")
  .map((entry) => entry.name)
  .toSorted();

const entry = (path: string) => ({
  "@effect-browser/source": `./src/${path}.ts`,
  types: `./dist/${path}.d.mts`,
  default: `./dist/${path}.mjs`,
});

it("exports modules by path, feature folders by index, and closes every internal", () => {
  assert.deepStrictEqual(manifest.exports, {
    "./package.json": "./package.json",
    ".": { workerd: entry("index"), ...entry("index") },
    "./Cdp": { workerd: entry("internal/cdp/workerd"), ...entry("Cdp") },
    ...Object.fromEntries(folders.map((folder) => [`./${folder}`, entry(`${folder}/index`)])),
    "./*": entry("*"),
    "./internal/*": null,
    ...Object.fromEntries(
      folders
        .filter((folder) => existsSync(new URL(`${folder}/internal/`, source)))
        .map((folder) => [`./${folder}/internal/*`, null]),
    ),
    "./index": null,
    "./*/index": null,
  });
});

it("the root holds every root module but Cdp, which loads playwright-core, and Site", () => {
  assert.deepStrictEqual(
    Object.keys(Root).toSorted(),
    modules(source).filter((module) => module !== "Cdp" && module !== "Site"),
  );
});

const featureIndex = (folder: string) =>
  Effect.promise(() => import(`../src/${folder}/index.ts`) as Promise<Record<string, unknown>>);

it.effect("each feature folder's index holds every module in the folder", () =>
  Effect.gen(function* () {
    for (const folder of folders) {
      const index = yield* featureIndex(folder);

      assert.deepStrictEqual(
        Object.keys(index).toSorted(),
        modules(new URL(`${folder}/`, source)),
        folder,
      );
    }
  }),
);

// As Effect's `effect/sql/SqlError/ConnectionError`: the package, the feature folder, the module
// and the class's own name, which a module's own class leaves out. Without one, Schema tells
// classes apart by their tag alone, so two packages' same-tagged classes would pass each other's
// `Schema.is`.
it.effect("every public Schema class's identifier is its path", () =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, Record<string, unknown>]> = [["", Root]];

    for (const folder of folders) entries.push([`${folder}/`, yield* featureIndex(folder)]);

    // A class another module re-exports, as `Moment` does `Window`, keeps its own module's path:
    // the root comes first, and each class counts once.
    const seen = new Set<unknown>();

    const classes = entries.flatMap(([folder, index]) =>
      Object.entries(index).flatMap(([module, exports]) =>
        Object.entries(exports as Record<string, unknown>).flatMap(([name, value]) =>
          typeof value === "function" &&
          Schema.isSchema(value) &&
          "identifier" in value &&
          !seen.has(value) &&
          seen.add(value)
            ? [
                {
                  value,
                  error: value.prototype instanceof Error,
                  path: `effect-browser/${folder}${module}${name === module ? "" : `/${name}`}`,
                },
              ]
            : [],
        ),
      ),
    );

    assert.isTrue(classes.some(({ error }) => error));
    assert.isTrue(classes.some(({ error }) => !error));
    assert.deepStrictEqual(
      classes.map(({ value }) => value.identifier),
      classes.map(({ path }) => path),
    );
  }),
);
