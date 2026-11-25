// `effect-browser/Site` as a site runs it: bundled and minified the way a site's own bundle would
// be, loaded by a page with a plain script tag, and called by the page's own code in its main
// world. The library's protocol plays no part; Playwright only loads the page and reads back what
// the page's code found.
import { fileURLToPath } from "node:url";

import { afterAll, assert, beforeAll, it } from "@effect/vitest";
import { type Browser, chromium } from "playwright-core";
import { rolldown } from "vite/rolldown";

import type * as Site from "../src/Site.ts";

declare global {
  // What the bundle defines in the page, as a site's would.
  var EffectBrowserSite: typeof Site;
}

const entry = fileURLToPath(new URL("../src/Site.ts", import.meta.url));
let browser: Browser;
let script: string;
let modules: ReadonlyArray<string>;

beforeAll(async () => {
  const bundle = await rolldown({ input: entry, platform: "browser" });

  try {
    const { output } = await bundle.generate({
      format: "iife",
      name: "EffectBrowserSite",
      minify: true,
    });

    const [chunk] = output;

    if (output.length !== 1 || chunk?.type !== "chunk") throw new Error("one chunk");
    script = chunk.code;
    modules = Object.keys(chunk.modules);
  } finally {
    await bundle.close();
  }
  browser = await chromium.launch({ headless: true });
});

afterAll(() => browser?.close());

// A save button whose form says what it did, and a counter outside the form that another of the
// site's acts moves.
const page = () => `<!doctype html><style>
body { margin: 0; font: 16px/1.5 sans-serif }
#save { position: absolute; left: 40px; top: 120px; width: 100px; height: 32px; margin: 0 }
</style>
<h1>Postal codes</h1>
<p id=lede>A quick brown fox reads the page.</p>
<form><button type=button id=save>Save</button><p id=state>Unsaved</p></form>
<button type=button id=count>Count</button><p id=counted>0</p>
<script>
save.addEventListener("click", () => { state.textContent = "Saved" });
count.addEventListener("click", () => { counted.textContent = "1" });
</script>
<script>${script}</script>`;

it("bundles for a site without effect", () => {
  assert.isNotEmpty(modules);
  assert.isFalse(
    modules.some((id) => /[\\/]node_modules[\\/]/.test(id)),
    modules.filter((id) => id.includes("node_modules")).join("\n"),
  );
});

it("reads, poses, draws and records on a page that loaded it itself", async () => {
  const tab = await browser.newPage({ viewport: { width: 640, height: 360 } });

  try {
    await tab.setContent(page());

    const result = await tab.evaluate(async () => {
      const site = globalThis.EffectBrowserSite.make();

      const picks = {
        save: { role: "button", name: "Save" },
        lede: { selector: "#lede", words: "quick" },
      };

      const read = site.layout(picks);

      if ("invalid" in read) throw new Error(read.invalid);
      const save = read.layout.places.find(({ id }) => id === "save");

      if (save === undefined) throw new Error("no save button");
      const posed = site.pose([{ ref: save.ref, dx: 10, dy: 5 }]);
      const moved = site.layout(picks);
      const refused = site.pose([{ ref: save.ref, dx: Number.NaN }]);

      site.unpose();

      const drawn = site.draw(
        `<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="12" width="30" height="20"/></svg>`,
      );

      // The site's own layer, which no reader reads and the record leaves out.
      const parcel = document.createElement("p");

      parcel.textContent = "Parcel waves";
      site.layer().append(parcel);
      site.record();
      await site.settle();
      // One act the site does through its app without a note, then one it notes.
      document.getElementById("count")?.click();
      await site.settle();
      const start = site.changes({ since: null, until: null, unmask: false });
      const button = site.element(save.ref);

      if (button === undefined) throw new Error("the save button's ref");
      site.note(button);
      if (button instanceof HTMLElement) button.click();
      parcel.textContent = "Parcel cheers";
      await site.settle();

      return {
        save,
        lede: read.layout.places.find(({ id }) => id === "lede"),
        posed,
        moved: moved.layout?.places.find(({ id }) => id === "save"),
        refused,
        stale: site.pose([{ ref: "e999" }]),
        drawn,
        found: site.find({ text: "Parcel" }),
        buttons: site.find({ role: "button" }),
        snapshot: site.snapshot({
          full: true,
          query: null,
          within: null,
          maxChars: 4000,
          boxes: false,
        }),
        text: site.text({ ref: null, maxChars: 4000, unmask: false }),
        ready: await site.ready(1000),
        uncaused: start.records,
        caused: site.changes({ since: start.until, until: null, unmask: false }).records,
        sameRef: site.ref(button) === save.ref,
        redacted: site.redact("https://user:secret@example.com/a?token=x&b=1"),
      };
    });

    assert.deepStrictEqual(result.save.box, { x: 40, y: 120, width: 100, height: 32 });
    assert.strictEqual(result.save.subject.name, "Save");
    assert.deepStrictEqual(
      result.lede?.words?.map(({ text }) => text),
      ["quick"],
    );
    assert.deepStrictEqual(result.posed, {});
    assert.deepStrictEqual(result.moved?.box, { x: 50, y: 125, width: 100, height: 32 });
    assert.property(result.refused, "invalid");
    assert.deepStrictEqual(result.stale, { stale: "e999" });
    assert.deepStrictEqual(result.drawn, [{ x: 10, y: 12, width: 30, height: 20 }]);
    assert.deepStrictEqual(result.found, { found: [] });
    assert.deepStrictEqual(
      result.buttons.found?.map(({ subject }) => subject.name),
      ["Save", "Count"],
    );
    assert.include(JSON.stringify(result.snapshot), 'button \\"Save\\"');
    assert.notInclude(JSON.stringify(result.snapshot), "Parcel");
    assert.include(result.text?.text, "Saved");
    assert.notInclude(result.text?.text, "Parcel");
    assert.deepStrictEqual(result.ready, []);

    // The act it did not note has no cause; the one it noted is the cause of what it changed, which
    // has its box. Its own layer changed too, and the record has none of it.
    const counted = result.uncaused.find(({ after }) => after === "1");
    const saved = result.caused.find(({ after }) => after === "Saved");

    assert.isDefined(counted);
    assert.isUndefined(counted?.cause);
    assert.isDefined(saved?.cause);
    assert.isDefined(saved?.box);
    assert.isFalse(
      [...result.uncaused, ...result.caused].some(({ after }) => after?.includes("Parcel")),
    );
    assert.isTrue(result.sameRef);
    assert.notInclude(result.redacted, "secret");
    assert.notInclude(result.redacted, "token=x");
  } finally {
    await tab.close();
  }
});
