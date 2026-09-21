import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { stageConsumer } from "../stage-consumer.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-stage-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tree = join(directory, "tree"), out = join(directory, "out"); mkdirSync(tree); mkdirSync(out);
  const write = (path, content) => { mkdirSync(dirname(join(tree, path)), { recursive: true }); writeFileSync(join(tree, path), content); };
  return { tree, out, write };
}

test("staging retains complete transitive examples and their unchanged public-package imports", (t) => {
  const f = fixture(t);
  const entry = "packages/browserbase/test/consumer/native.ts";
  f.write(entry, 'import "../../examples/record-video.ts";\n');
  f.write("packages/browserbase/examples/record-video.ts", 'import { start } from "@effect-agent/browserbase/capture";\nexport { fixture } from "../test/fixtures/local.ts";\n');
  f.write("packages/browserbase/test/fixtures/local.ts", 'export const fixture = true;\n');
  const files = stageConsumer(f.tree, f.out, [entry]);
  assert.equal(files.length, 3);
  for (const path of files) assert.deepEqual(readFileSync(join(f.out, path)), readFileSync(join(f.tree, path)));
  rmSync(join(f.tree, "packages/browserbase/test/fixtures/local.ts"));
  assert.throws(() => stageConsumer(f.tree, f.out, [entry]), /ENOENT/);
});

test("a maintained example cannot smuggle production code or local module aliases into a packed consumer", (t) => {
  const f = fixture(t), entry = "packages/browserbase/examples/demo.ts";
  for (const specifier of ["../src/Browser.ts", "/tmp/browser.ts", "file:/tmp/browser.mjs", "#workspace-browser"]) {
    f.write(entry, `import ${JSON.stringify(specifier)};\n`);
    assert.throws(() => stageConsumer(f.tree, f.out, [entry]));
  }
});
