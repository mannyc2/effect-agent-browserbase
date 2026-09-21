import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { verifyConsumer } from "../verify-consumer.mjs";
import { packages } from "../packages.mjs";

const version = "0.1.0-beta.102";
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const json = (path, value) => write(path, JSON.stringify(value) + "\n");

// Real on-disk packages and tar archives exercise the verifier, not browser behavior.
function fixture(t, { profile = "resources", source = "export const owner = {};\n" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-consumer-isolation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "consumer"), artifacts = join(directory, "artifacts");
  mkdirSync(artifacts); json(join(root, "package.json"), { private: true, type: "module" });
  const entries = [];
  for (const item of profile === "agent" ? packages : [packages[0]]) {
    const stage = join(directory, item.stem), content = join(stage, "package");
    const stems = item === packages[0] ? ["index"] : ["index", "Adapter", "Tools"];
    const subpaths = item === packages[0] ? ["."] : [".", "./adapter", "./tools"];
    const exports = Object.fromEntries(stems.map((stem, i) => [subpaths[i], { types: `./dist/${stem}.d.mts`, default: `./dist/${stem}.mjs` }]));
    json(join(content, "package.json"), { name: item.name, version, type: "module", exports });
    const members = ["package/package.json"];
    for (const stem of stems) {
      write(join(content, "dist", stem + ".mjs"), item === packages[0] ? source : `export { owner } from "${packages[0].name}";\n`);
      write(join(content, "dist", stem + ".d.mts"), "export declare const owner: object;\n");
      members.push(`package/dist/${stem}.mjs`, `package/dist/${stem}.d.mts`);
    }
    const filename = item.stem + "-" + version + ".tgz";
    execFileSync("tar", ["-czf", join(artifacts, filename), "-C", stage, ...members]);
    cpSync(content, join(root, "node_modules", item.name), { recursive: true });
    entries.push({ name: item.name, filename });
  }
  json(join(artifacts, "release-set.json"), { schemaVersion: 2, version, sourceSha: "1".repeat(40), packages: entries });
  return { root, artifacts, directory, generic: join(root, "node_modules", packages[0].name), verify: () => verifyConsumer(root, artifacts, profile) };
}

function install(directory, name, { exports = { ".": "./index.mjs" }, source = "export const installed = true;\n" } = {}) {
  json(join(directory, "package.json"), { name, version: "1.0.0", type: "module", exports });
  write(join(directory, "index.mjs"), source);
}

test("accepts a resources-only candidate without framework or native dependencies", async (t) => {
  const f = fixture(t);
  install(join(f.root, "node_modules", "effect"), "effect");
  assert.equal((await f.verify()).profile, "resources");
});

for (const name of ["playwright-core", "effect-agent", "@effect-agent/testing", "@browserbasehq/sdk"]) {
  test(`rejects nested ${name} invisible to root resolution`, async (t) => {
    const f = fixture(t);
    install(join(f.generic, "node_modules", name), name);
    const require = createRequire(join(f.root, "package.json"));
    assert.throws(() => require.resolve(name), { code: "MODULE_NOT_FOUND" });
    await assert.rejects(f.verify(), /Forbidden installed dependency/);
  });
}

test("rejects an aliased dependency even when its root export is hidden", async (t) => {
  const f = fixture(t);
  install(join(f.generic, "node_modules", "innocent-alias"), "effect-agent", { exports: { "./feature": "./index.mjs" } });
  await assert.rejects(f.verify(), /Forbidden installed dependency/);
});

test("rejects transitive nested dependencies before candidate code executes", async (t) => {
  const marker = join(tmpdir(), `browserbase-import-marker-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(marker, { force: true }));
  const f = fixture(t, { source: `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export const owner = {};\n` });
  const helper = join(f.generic, "node_modules", "helper");
  install(helper, "helper");
  install(join(helper, "node_modules", "playwright-core"), "playwright-core");
  await assert.rejects(f.verify(), /Forbidden installed dependency/);
  assert.equal(existsSync(marker), false, "Candidate executed before dependency admission");
});

for (const store of [".bun", ".pnpm"]) {
  test(`accepts in-consumer ${store} links and rejects a forbidden store package`, async (t) => {
    const f = fixture(t);
    const cached = join(f.root, "node_modules", store, "effect@4", "node_modules", "effect");
    install(cached, "effect");
    symlinkSync(cached, join(f.root, "node_modules", "effect"), "dir");
    assert.equal((await f.verify()).profile, "resources");
    install(join(f.root, "node_modules", store, "hidden@1", "node_modules", "alias"), "playwright-core");
    await assert.rejects(f.verify(), /Forbidden installed dependency/);
  });
}

test("rejects dependency links outside the clean consumer", async (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside");
  install(outside, "effect");
  symlinkSync(outside, join(f.root, "node_modules", "effect"), "dir");
  await assert.rejects(f.verify(), /outside this clean consumer/);
});

test("terminates on in-consumer dependency cycles", async (t) => {
  const f = fixture(t);
  const helper = join(f.root, "node_modules", "helper");
  install(helper, "helper");
  mkdirSync(join(helper, "node_modules"));
  symlinkSync(helper, join(helper, "node_modules", "helper"), "dir");
  assert.equal((await f.verify()).profile, "resources");
});

test("generic native profile allows Playwright but rejects a nested framework", async (t) => {
  const f = fixture(t, { profile: "generic" });
  install(join(f.root, "node_modules", "playwright-core"), "playwright-core");
  assert.equal((await f.verify()).profile, "generic");
  install(join(f.generic, "node_modules", "effect-agent"), "effect-agent");
  await assert.rejects(f.verify(), /Forbidden installed dependency/);
});

test("agent profile retains canonical shared-owner and retired-export checks", async (t) => {
  const f = fixture(t, { profile: "agent" });
  install(join(f.root, "node_modules", "effect-agent"), "effect-agent");
  install(join(f.root, "node_modules", "playwright-core"), "playwright-core");
  assert.equal((await f.verify()).profile, "agent");
  const generic = await import(pathToFileURL(join(f.generic, "dist/index.mjs")).href);
  const adapter = await import(pathToFileURL(join(f.root, "node_modules", packages[1].name, "dist/Adapter.mjs")).href);
  assert.equal(adapter.owner, generic.owner);
});
