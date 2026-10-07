// The package's entry points are exactly its public modules and its test kits: the build also
// emits shared chunks beside them, and only a listed subpath may resolve to one of its files.
import { readdirSync, readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

const modules = readdirSync(new URL("../src/", import.meta.url))
  .filter((file) => file.endsWith(".ts") && file !== "index.ts")
  .map((file) => file.slice(0, -3))
  .toSorted();

it("exports the root, each public module and the test kits, and nothing else", () => {
  assert.deepStrictEqual(
    Object.keys(manifest.exports).toSorted(),
    [".", "./testing", ...modules.map((module) => `./${module}`)].toSorted(),
  );
  assert.deepStrictEqual(manifest.exports["./testing"], {
    "@effect-browser/source": "./src/testing/index.ts",
    types: "./dist/testing/index.d.mts",
    default: "./dist/testing/index.mjs",
  });

  for (const module of modules)
    assert.deepStrictEqual(manifest.exports[`./${module}`], {
      "@effect-browser/source": `./src/${module}.ts`,
      types: `./dist/${module}.d.mts`,
      default: `./dist/${module}.mjs`,
    });
});
