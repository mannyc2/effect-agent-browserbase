/** Real Chromium reads and input through published code rebundled with preserved names. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, assert, beforeAll, it } from "@effect/vitest";
import { build as esbuild } from "esbuild";
import { chromium } from "playwright-core";
import { build as rolldown } from "vite/rolldown";

import { installSource } from "../src/internal/page/bridge.ts";
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

// PLAN's hand-maintained version finding: reconnecting changed code must replace an existing
// install, dispose its observers and retain its floor, even when no version number was edited.
it("replaces an installed page script when its source changes", async () => {
  const changed = installSource.replace(
    "SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK SVG",
    "SCRIPT STYLE NOSCRIPT TEMPLATE HEAD META LINK SVG AUDIT",
  );

  assert.notStrictEqual(changed, installSource);
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.setContent("<button>Current control</button>");
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send("Page.getFrameTree");

    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "effect-browser",
    });

    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      contextId: executionContextId,
      returnByValue: true,
      expression: `(() => {
        const first = ${installSource};
        first.snapshot({full:false,query:null,within:null,maxChars:12000});
        const floor = first.refs.next;
        let disposed = false;
        const dispose = first.dispose;
        first.dispose = () => { dispose(); disposed = true; };
        const second = ${changed};
        return {changed: first.version !== second.version, disposed, keptFloor: second.refs.next === floor};
      })()`,
    });

    assert.isUndefined(exceptionDetails);
    assert.deepStrictEqual(result.value, { changed: true, disposed: true, keptFloor: true });
  } finally {
    await browser.close();
  }
});

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

  assert.isTrue(inputs.some((name) => name.endsWith("dist/index.mjs")));
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

    assert.strictEqual(result.seededAction, "Click");
    assert.include(result.outline, 'heading "Bundled page"');
    assert.isTrue(result.disabled);
    assert.isFalse(result.disabledWait);
    assert.strictEqual(result.blockedInput, "NotActionable");
    assert.strictEqual(result.controls.find(({ name }) => name === "Legend")?.disabled, undefined);
    for (const name of ["Color", "File"]) {
      const control = result.controls.find((control) => control.name === name);

      assert.isDefined(control, name);
      assert.notStrictEqual(control?.kind, "textbox", name);
      assert.notStrictEqual(control?.editable, true, name);
    }
    assert.include(result.typed, "bundled");
    assert.isAbove(result.changeCount, 0);
    assert.strictEqual(result.oldRef, "StaleRef");
    assert.deepStrictEqual(result.found, ["Save"]);
    assert.include(result.text, "Waiting");
    assert.strictEqual(result.outcome, "Done");
    assert.include(result.saved, "Saved");
    assert.strictEqual(result.moving, "Timeout");
    assert.include(result.next, 'heading "Next document"');
  },
);
