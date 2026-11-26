// The exports follow Effect's layout: the root barrel, a module per file, and closed internals,
// where the build also puts its shared chunks.
import { readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";

import * as Root from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

it("exports the root barrel and its modules by path, and closes internals", () => {
  assert.deepStrictEqual(manifest.exports, {
    "./package.json": "./package.json",
    ".": {
      "@effect-browser/source": "./src/index.ts",
      types: "./dist/index.d.mts",
      default: "./dist/index.mjs",
    },
    "./*": {
      "@effect-browser/source": "./src/*.ts",
      types: "./dist/*.d.mts",
      default: "./dist/*.mjs",
    },
    "./internal/*": null,
    "./index": null,
    "./*/index": null,
  });
  assert.deepStrictEqual(Object.keys(Root), ["Moments", "YieldedTools"]);
});
