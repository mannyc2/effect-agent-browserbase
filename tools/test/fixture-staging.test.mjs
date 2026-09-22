import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stageConsumer } from "../stage-consumer.mjs";
import { consumerManifest } from "../packed-consumers.mjs";
import { packages } from "../packages.mjs";

const catalog = { effect: "4.0.0-rc.115", "@types/node": "26.1.2", typescript: "7.0.2", "vite-plus": "0.3.2", "playwright-core": "1.63.0", "@effect/vitest": "4.0.0-rc.115", "@effect/platform-node": "4.0.0-rc.115", vitest: "4.1.11" };
const receipt = { frameworkVersion: "0.1.0-beta.102", packages: packages.map((p) => ({ filename: p.stem + "-0.1.0-beta.102.tgz" })) };

test("three clean consumer manifests isolate resources and substitute only the private consumer's artifact resolution", () => {
  const resources = consumerManifest("resources", receipt, "/tmp/artifacts", catalog);
  assert.deepEqual(Object.keys(resources.dependencies).sort(), [packages[0].name, "effect"].sort());
  assert.equal(resources.devDependencies["@effect-agent/testing"], undefined);
  assert.equal(resources.dependencies["playwright-core"], undefined);
  const generic = consumerManifest("generic", receipt, "/tmp/artifacts", catalog);
  assert.equal(generic.dependencies["playwright-core"], catalog["playwright-core"]);
  assert.equal(generic.dependencies["effect-agent"], undefined);
  assert.equal(generic.devDependencies["@effect/platform-node"], catalog["@effect/platform-node"]);
  assert.equal(resources.devDependencies["@effect/platform-node"], undefined);
  const agent = consumerManifest("agent", receipt, "/tmp/artifacts", catalog);
  assert.equal(agent.dependencies["effect-agent"], receipt.frameworkVersion);
  assert.equal(agent.overrides[packages[0].name], agent.dependencies[packages[0].name]);
  assert.match(agent.dependencies[packages[1].name], /^file:/);
});

test("native fixture closure may share generic test-only helpers but cannot traverse a symlink", (t) => {
  const root = mkdtempSync(join(tmpdir(), "browserbase-fixture-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = join(root, "tree"), out = join(root, "out"); mkdirSync(tree); mkdirSync(out);
  const write = (path, content) => { mkdirSync(dirname(join(tree, path)), { recursive: true }); writeFileSync(join(tree, path), content); };
  const entry = "packages/agent-browserbase/test/native/agent.test.ts";
  const dependency = "packages/browserbase/test/fixtures/local.ts";
  write(entry, 'import "../../../browserbase/test/fixtures/local.ts";\n');
  write(dependency, "export const sentinel = 1;\n");
  const files = stageConsumer(tree, out, [entry]);
  assert.equal(files.length, 2); assert.deepEqual(readFileSync(join(out, dependency)), readFileSync(join(tree, dependency)));
  rmSync(join(tree, dependency)); symlinkSync(join(root, "outside.ts"), join(tree, dependency)); writeFileSync(join(root, "outside.ts"), "export {};\n");
  assert.throws(() => stageConsumer(tree, out, [entry]), /regular file/);
});
