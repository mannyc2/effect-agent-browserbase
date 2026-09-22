import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const generic = JSON.parse(read("packages/browserbase/package.json"));
const browser = JSON.parse(read("packages/browser/package.json"));
const adapter = JSON.parse(read("packages/agent-browser/package.json"));

test("generic installation contracts do not acquire the framework or framework testing", () => {
  assert.equal(generic.name, "effect-browserbase");
  for (const manifest of [browser, generic]) {
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
      for (const dependency of Object.keys(manifest[section] ?? {})) {
        assert.notEqual(dependency, "effect-agent");
        assert.notEqual(dependency, "@effect-agent/testing");
      }
    }
  }
  assert.equal(browser.peerDependenciesMeta["playwright-core"].optional, true);
  assert.equal(generic.peerDependencies["playwright-core"], undefined);
  assert.equal(browser.version, generic.version);
  assert.equal(generic.version, adapter.version);
  assert.equal(browser.peerDependencies.effect, generic.peerDependencies.effect);
  assert.equal(generic.peerDependencies.effect, adapter.peerDependencies.effect);
});

for (const [directory, manifest] of [["browser", browser], ["browserbase", generic], ["agent-browser", adapter]]) {
test(`every ${manifest.name} public entry has a real module and declaration build entry`, () => {
  const configuration = read(`packages/${directory}/vite.config.ts`);
  const entries = [...configuration.matchAll(/"(src\/[^\"]+\.ts)"/g)].map((match) => `./${match[1]}`);
  assert.deepEqual(entries.toSorted(), Object.values(manifest.exports).toSorted());
  assert.equal(new Set(entries).size, entries.length);
  for (const [key, target] of Object.entries(manifest.exports)) {
    assert.ok(key === "." || /^\.\/[a-z][a-z-]+$/.test(key));
    assert.ok(!key.includes("legacy") && !key.includes("internal"));
    const source = read(`packages/${directory}/${target.slice(2)}`);
    if (directory !== "agent-browser") assert.doesNotMatch(source, /from\s+["'](?:effect-agent|effect-agent-browserbase|@effect-agent\/testing|playwright-core)[/"']/);
    else assert.doesNotMatch(source, /from\s+["'](?:effect-browserbase|effect-agent-browserbase)[/"']/);
  }
  assert.equal(JSON.parse(read(`packages/${directory}/tsconfig.json`)).compilerOptions.skipLibCheck, false);
});

test(`${manifest.name} keeps declaration helpers private while retaining explicit chunk exports`, async () => {
  // The hook is plain JavaScript; isolate it from Vite's configuration loader here.
  // The emitted declarations are separately checked by the pinned compiler in acceptance.
  const source = read(`packages/${directory}/vite.config.ts`).replace(
    'import { defineConfig } from "vite-plus";',
    'const defineConfig = (config) => config;',
  );
  const { default: configuration } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const hook = configuration.pack.plugins.find((plugin) => plugin.name === "public-entry-namespaces").renderChunk;
  assert.equal(hook.order, "post", "Declaration export context must follow declaration rendering");
  for (const [fileName, code] of [
    ["CaptureData.d.mts", 'declare const Private_base: object;\nexport declare const Public: typeof Private_base;'],
    ["CaptureData-12345678.d.mts", 'declare const Private_base: object;\nexport { Private_base as t };'],
    ["Browser.d.mts", 'export interface BrowserSession { readonly close: () => void; }'],
  ]) {
    const rendered = hook.handler(code, { fileName });
    assert.equal(rendered.code, `${code}\nexport {};`, "All explicit declarations and exports must be retained");
    assert.equal(rendered.map, null, "Appending an unmapped marker leaves existing mappings unchanged");
  }
  for (const fileName of ["index.mjs", "CaptureData-12345678.mjs", "CaptureData.d.mts.map"]) {
    assert.equal(hook.handler('export const Public = {};', { fileName }), undefined, `${fileName} must remain unchanged`);
  }
});
}

test("unpaid acceptance cannot silently omit the generic package", () => {
  assert.match(read("tools/bootstrap.sh"), /'packages\/browser', 'packages\/browserbase', 'packages\/agent-browser', 'test'/);
  const acceptance = read("tools/run-acceptance.sh");
  for (const gate of ["integration-typecheck", "integration-unit", "browser-typecheck", "browser-unit", "browser-build", "generic-typecheck", "generic-unit", "generic-build"]) {
    assert.match(acceptance, new RegExp(`run ${gate} timeout`));
  }
  assert.match(acceptance, /ls-files -z -- packages\/browser packages\/browserbase packages\/agent-browser test/);
});

test("bootstrap's lock and guide describe the canonical adapter rather than retired reexports", () => {
  const patch = read("upstream.patch");
  const start = patch.indexOf('+    "packages/agent-browser": {');
  const end = patch.indexOf('+    },', start) + '+    },'.length;
  assert.ok(start > 0 && end > start, "the pinned patch contains the adapter workspace inventory");
  const workspace = patch.slice(start, end).replace(/^\+/gm, "");
  const dependencies = workspace.slice(workspace.indexOf('"dependencies"'), workspace.indexOf('"devDependencies"'));
  assert.match(dependencies, /"effect-browser": "workspace:\*"/);
  assert.doesNotMatch(dependencies, /effect-browserbase/);
  assert.match(dependencies, /"effect-agent": "workspace:\*"/);
  const peers = workspace.slice(workspace.indexOf('"peerDependencies"'));
  assert.doesNotMatch(peers, /playwright-core|optionalPeers/);
  assert.match(patch, /`effect-browser` owns modeled browser sessions/);
  assert.match(patch, /reaches the isolated Chromium process module/);
  assert.doesNotMatch(patch, /The adapter also exposes independent `recordings`/);
  assert.match(patch, /fromSession\(session\)/);
});
