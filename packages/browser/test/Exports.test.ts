// The package's entry points are exactly its public modules: the build also emits shared chunks
// beside them, and only a listed subpath may resolve to one of its files.
import { readdirSync, readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";

import * as Cdp from "../src/Cdp.ts";
import * as Root from "../src/index.ts";

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
      ...(module === "Cdp"
        ? {
            workerd: {
              "@effect-browser/source": "./src/workerd/Cdp.ts",
              types: "./dist/workerd/Cdp.d.mts",
              default: "./dist/workerd/Cdp.mjs",
            },
          }
        : {}),
      "@effect-browser/source": `./src/${module}.ts`,
      types: `./dist/${module}.d.mts`,
      default: `./dist/${module}.mjs`,
    });

  assert.deepStrictEqual(manifest.exports["."], {
    workerd: {
      "@effect-browser/source": "./src/workerd/index.ts",
      types: "./dist/workerd/index.d.mts",
      default: "./dist/workerd/index.mjs",
    },
    "@effect-browser/source": "./src/index.ts",
    types: "./dist/index.d.mts",
    default: "./dist/index.mjs",
  });
});

it("the default root overrides the portable CDP namespace with Node's connector", () => {
  assert.strictEqual(Root.Cdp.open, Cdp.open);
  assert.strictEqual(Root.Cdp.layer, Cdp.layer);
  assert.isFunction(Root.Chromium.open);
});
