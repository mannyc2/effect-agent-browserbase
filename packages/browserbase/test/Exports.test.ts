// The exports follow Effect's layout: the root barrel, a module per file, the test kits' folder
// by its index, and closed internals, where the build also puts its shared chunks.
import { readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import * as BrowserError from "effect-browser/BrowserError";

import * as BrowserbaseError from "../src/BrowserbaseError.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, unknown>;
};

const entry = (path: string) => ({
  "@effect-browser/source": `./src/${path}.ts`,
  types: `./dist/${path}.d.mts`,
  default: `./dist/${path}.mjs`,
});

it("exports modules by path, the test kits by index, and closes internals", () => {
  assert.deepStrictEqual(manifest.exports, {
    "./package.json": "./package.json",
    ".": entry("index"),
    "./testing": entry("testing/index"),
    "./*": entry("*"),
    "./internal/*": null,
    "./index": null,
    "./*/index": null,
  });
});

// Both packages have a `NotFound` and an `InvalidRequest` reason; only their identifiers differ.
it("tells its reasons from the core's of the same tag", () => {
  const core = new BrowserError.NotFound({ target: "the session" });
  const own = new BrowserbaseError.NotFound({ detail: "the session" });

  assert.deepStrictEqual(
    [core, own].map((reason) => [
      BrowserError.isBrowserErrorReason(reason),
      BrowserbaseError.isBrowserbaseErrorReason(reason),
    ]),
    [
      [true, false],
      [false, true],
    ],
  );
});
