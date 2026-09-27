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
    for (const section of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
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

for (const [directory, manifest] of [
  ["browser", browser],
  ["browserbase", generic],
  ["agent-browser", adapter],
]) {
  test(`every ${manifest.name} public entry has a real module and declaration build entry`, () => {
    const configuration = read(`packages/${directory}/vite.config.ts`);

    const entries = [...configuration.matchAll(/"(src\/[^"]+\.ts)"/g)].map(
      (match) => `./${match[1]}`,
    );

    assert.deepEqual(entries.toSorted(), Object.values(manifest.exports).toSorted());
    assert.equal(new Set(entries).size, entries.length);
    for (const [key, target] of Object.entries(manifest.exports)) {
      assert.ok(key === "." || /^\.\/[a-z][a-z-]+$/.test(key));
      assert.ok(!key.includes("legacy") && !key.includes("internal"));
      const source = read(`packages/${directory}/${target.slice(2)}`);

      if (directory !== "agent-browser")
        assert.doesNotMatch(
          source,
          /from\s+["'](?:effect-agent|effect-agent-browserbase|@effect-agent\/testing|playwright-core)[/"']/,
        );
      else
        assert.doesNotMatch(
          source,
          /from\s+["'](?:effect-browserbase|effect-agent-browserbase)[/"']/,
        );
    }
    assert.equal(
      JSON.parse(read(`packages/${directory}/tsconfig.json`)).compilerOptions.skipLibCheck,
      false,
    );
  });

  test(`${manifest.name} keeps declaration helpers private while retaining explicit chunk exports`, async () => {
    // The hook is plain JavaScript; isolate it from Vite's configuration loader here.
    // The emitted declarations are separately checked by the pinned compiler in acceptance.
    const source = read(`packages/${directory}/vite.config.ts`).replace(
      'import { defineConfig } from "vite-plus";',
      "const defineConfig = (config) => config;",
    );

    const { default: configuration } = await import(
      `data:text/javascript,${encodeURIComponent(source)}`
    );

    const hook = configuration.pack.plugins.find(
      (plugin) => plugin.name === "public-entry-namespaces",
    ).renderChunk;

    assert.equal(
      hook.order,
      "post",
      "Declaration export context must follow declaration rendering",
    );
    for (const [fileName, code] of [
      [
        "CaptureData.d.mts",
        "declare const Private_base: object;\nexport declare const Public: typeof Private_base;",
      ],
      [
        "CaptureData-12345678.d.mts",
        "declare const Private_base: object;\nexport { Private_base as t };",
      ],
      ["Browser.d.mts", "export interface BrowserSession { readonly close: () => void; }"],
    ]) {
      const rendered = hook.handler(code, { fileName });

      assert.equal(
        rendered.code,
        `${code}\nexport {};`,
        "All explicit declarations and exports must be retained",
      );
      assert.equal(
        rendered.map,
        null,
        "Appending an unmapped marker leaves existing mappings unchanged",
      );
    }
    for (const fileName of ["index.mjs", "CaptureData-12345678.mjs", "CaptureData.d.mts.map"]) {
      assert.equal(
        hook.handler("export const Public = {};", { fileName }),
        undefined,
        `${fileName} must remain unchanged`,
      );
    }
  });
}

test("unpaid acceptance cannot silently omit the generic package", () => {
  // The workspace is the whole committed tree, not a list of copied paths.
  assert.match(read("tools/workspace.sh"), /git -C "\$ROOT" archive --format=tar HEAD \| tar -x -C "\$TREE"/);
  const acceptance = read("tools/run-acceptance.sh");

  for (const gate of [
    "browser-typecheck",
    "browser-unit",
    "browser-build",
    "generic-typecheck",
    "generic-unit",
    "generic-build",
  ]) {
    assert.match(acceptance, new RegExp(`run ${gate} timeout`));
  }
  assert.match(
    acceptance,
    /run review-check git diff --check .* -- packages\/browser packages\/browserbase packages\/agent-browser lint scripts\n/,
  );
});

test("the lockfile describes the canonical adapter rather than retired reexports", () => {
  // bun.lock is JSON with trailing commas.
  const lock = JSON.parse(read("bun.lock").replace(/,(\s*[}\]])/g, "$1"));
  const workspace = lock.workspaces["packages/agent-browser"];

  assert.ok(workspace, "the lockfile contains the adapter workspace inventory");
  assert.equal(workspace.dependencies, undefined);
  assert.equal(workspace.devDependencies["effect-browser"], "workspace:*");
  assert.match(workspace.devDependencies["effect-agent"], /^0\.[0-9]+\.[0-9]+-beta\.[0-9]+$/);
  assert.equal(workspace.peerDependencies["effect-browser"], "workspace:*");
  assert.equal(workspace.peerDependencies["effect-agent"], workspace.devDependencies["effect-agent"]);
  assert.equal(workspace.peerDependencies["effect-browserbase"], undefined);
  assert.equal(workspace.peerDependencies["playwright-core"], undefined);
  assert.equal(workspace.optionalPeers, undefined);
  // The framework is a registry release, never a workspace a later install could substitute.
  assert.match(lock.packages["effect-agent"][0], /^effect-agent@0\.[0-9]+\.[0-9]+-beta\.[0-9]+$/);
  assert.match(read("scripts/verify-package-purity.ts"), /reaches the isolated Chromium process module/);
});
