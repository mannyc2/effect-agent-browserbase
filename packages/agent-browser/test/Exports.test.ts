// The package's entry points are exactly its public modules: the build also emits shared chunks
// beside them, and only a listed subpath may resolve to one of its files.
import { readdirSync, readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

const modules = readdirSync(new URL("../src/", import.meta.url))
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => file.slice(0, -3))
  .toSorted();

it("exports the root and each public module, and nothing else", () => {
  assert.deepStrictEqual(
    Object.keys(manifest.exports).toSorted(),
    [".", ...modules.map((module) => `./${module}`)].toSorted(),
  );

  for (const module of modules)
    assert.deepStrictEqual(manifest.exports[`./${module}`], {
      "@effect-browser/source": `./src/${module}.ts`,
      types: `./dist/${module}.d.mts`,
      default: `./dist/${module}.mjs`,
    });
});
