// Public entry points resolve to owned modules; internal chunks stay unreachable as package paths.
import { existsSync, readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";

import * as Root from "../src/index.ts";

interface Entry {
  readonly "@effect-browser/source": string;
  readonly types: string;
  readonly default: string;
  readonly workerd?: Entry;
}

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  readonly exports: Record<string, Entry>;
};

it("exports explicit public modules whose source targets exist", () => {
  for (const [path, target] of Object.entries(manifest.exports)) {
    assert.notInclude(path, "*");
    assert.notInclude(path, "internal");
    assert.isTrue(
      existsSync(new URL(`../${target["@effect-browser/source"]}`, import.meta.url)),
      path,
    );
  }
});

it("the root exposes the portable kernel without importing optional features or providers", () => {
  assert.deepStrictEqual(Object.keys(Root).toSorted(), [
    "Action",
    "ActionPort",
    "Browser",
    "BrowserError",
    "BrowserEvent",
    "Change",
    "Clock",
    "Frame",
    "Geometry",
    "Page",
    "Snapshot",
    "Style",
    "Url",
    "Window",
  ]);
  const root = manifest.exports["."]!;

  assert.deepStrictEqual(root.workerd, {
    "@effect-browser/source": root["@effect-browser/source"],
    types: root.types,
    default: root.default,
  });
});
