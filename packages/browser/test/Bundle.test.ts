/** Real Chromium reads and input through published code rebundled with preserved names. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, assert, beforeAll, it } from "@effect/vitest";
import { build as esbuild } from "esbuild";
import { build as rolldown } from "vite/rolldown";

import type * as Consumer from "./bundled-consumer.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = join(root, ".work");

mkdirSync(work, { recursive: true });
const directory = mkdtempSync(join(work, "consumer-bundle-"));
const entry = fileURLToPath(new URL("./bundled-consumer.ts", import.meta.url));

beforeAll(() => {
  // Resolve the default published exports, never the workspace's source condition.
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "pipe" });
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it("bundles the published root and Cdp entry points for Workers", async () => {
  const bundle = await esbuild({
    stdin: {
      contents: `import * as Browser from "effect-browser"; import * as Cdp from "effect-browser/Cdp"; export { Browser, Cdp };`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    conditions: ["workerd"],
    external: ["effect"],
  });

  const inputs = Object.keys(bundle.metafile.inputs);

  assert.isTrue(inputs.some((name) => name.endsWith("dist/workerd/index.mjs")));
  assert.isTrue(inputs.some((name) => name.endsWith("dist/workerd/Cdp.mjs")));
  assert.isFalse(inputs.some((name) => name.includes("playwright-core")));
  assert.isFalse(inputs.some((name) => name.endsWith("/Chromium.mjs")));
});

it.each([
  ["esbuild", false],
  ["esbuild", true],
  ["rolldown", false],
  ["rolldown", true],
] as const)(
  "%s preserves page operations with keepNames and minify=%s",
  async (bundler, minify) => {
    const output = join(directory, `${bundler}-${minify}.mjs`);

    if (bundler === "esbuild")
      await esbuild({
        entryPoints: [entry],
        outfile: output,
        bundle: true,
        platform: "node",
        format: "esm",
        keepNames: true,
        minify,
        external: ["effect", "playwright-core"],
      });
    else
      await rolldown({
        input: entry,
        external: ["effect", "playwright-core"],
        output: { file: output, format: "esm", keepNames: true, minify },
      });

    const consumer = (await import(pathToFileURL(output).href)) as typeof Consumer;

    const result = await consumer.run();

    assert.include(result.outline, 'heading "Bundled page"');
    assert.deepStrictEqual(result.controls, ["Note", "Save"]);
    assert.deepStrictEqual(result.found, ["Save"]);
    assert.include(result.text, "Waiting");
    assert.strictEqual(result.outcome, "Done");
    assert.include(result.saved, "Saved");
    assert.strictEqual(result.moving, "Timeout");
    assert.include(result.next, 'heading "Next document"');
  },
);
