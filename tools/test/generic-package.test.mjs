import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const generic = JSON.parse(read("packages/browserbase/package.json"));

test("generic installation contracts do not acquire the framework or framework testing", () => {
  assert.equal(generic.name, "@effect-agent/browserbase");
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
    for (const dependency of Object.keys(generic[section] ?? {})) {
      assert.notEqual(dependency, "effect-agent");
      assert.notEqual(dependency, "@effect-agent/testing");
    }
  }
  assert.equal(generic.peerDependenciesMeta["playwright-core"].optional, true);
  const adapter = JSON.parse(read("packages/platform-browserbase/package.json"));
  assert.equal(generic.version, adapter.version);
  assert.equal(generic.peerDependencies.effect, adapter.peerDependencies.effect);
});

test("every generic public entry has a real module and declaration build entry", () => {
  const configuration = read("packages/browserbase/vite.config.ts");
  const entries = [...configuration.matchAll(/"(src\/[^\"]+\.ts)"/g)].map((match) => `./${match[1]}`);
  assert.deepEqual(entries.toSorted(), Object.values(generic.exports).toSorted());
  assert.equal(new Set(entries).size, entries.length);
  for (const [key, target] of Object.entries(generic.exports)) {
    assert.ok(key === "." || /^\.\/[a-z][a-z-]+$/.test(key));
    assert.ok(!key.includes("legacy") && !key.includes("internal"));
    const source = read(`packages/browserbase/${target.slice(2)}`);
    assert.doesNotMatch(source, /from\s+["'](?:effect-agent|@effect-agent\/testing|playwright-core)[/"']/);
  }
  assert.equal(JSON.parse(read("packages/browserbase/tsconfig.json")).compilerOptions.skipLibCheck, false);
});

test("unpaid acceptance cannot silently omit the generic package", () => {
  assert.match(read("tools/bootstrap.sh"), /'packages\/browserbase', 'packages\/platform-browserbase'/);
  const acceptance = read("tools/run-acceptance.sh");
  for (const gate of ["generic-typecheck", "generic-unit", "generic-build"]) {
    assert.match(acceptance, new RegExp(`run ${gate} timeout`));
  }
  assert.match(acceptance, /ls-files -z -- packages\/browserbase packages\/platform-browserbase/);
});

test("bootstrap's lock and guide describe the canonical adapter rather than retired reexports", () => {
  const patch = read("upstream.patch");
  const start = patch.indexOf('+    "packages/platform-browserbase": {');
  const end = patch.indexOf('     "packages/platform-cloudflare": {', start);
  assert.ok(start > 0 && end > start, "the pinned patch contains the adapter workspace inventory");
  const workspace = patch.slice(start, end).replace(/^\+/gm, "");
  const dependencies = workspace.slice(workspace.indexOf('"dependencies"'), workspace.indexOf('"devDependencies"'));
  assert.match(dependencies, /"@effect-agent\/browserbase": "workspace:\*"/);
  assert.match(dependencies, /"effect-agent": "workspace:\*"/);
  const peers = workspace.slice(workspace.indexOf('"peerDependencies"'));
  assert.doesNotMatch(peers, /playwright-core|optionalPeers/);
  assert.match(patch, /generic `@effect-agent\/browserbase` package owns independent/);
  assert.doesNotMatch(patch, /The adapter also exposes independent `recordings`/);
  assert.match(patch, /fromSession\(session\)/);
});
