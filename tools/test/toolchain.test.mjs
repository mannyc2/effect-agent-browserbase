import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const toolchain = read("tools/pinned-toolchain.sh");

test("the fetcher takes the Node pin from the same file every other command asserts", () => {
  assert.ok(toolchain.includes('NODE_VERSION="$(cat "$ROOT/.node-version")"'));
  const nodePin = read(".node-version").trim();
  assert.match(nodePin, /^\d+\.\d+\.\d+$/);
  // A second copy of the version would drift away from the assertions silently.
  assert.ok(!toolchain.includes(nodePin), "Node version must not be duplicated in the fetcher");
});

test("the Bun pin agrees with acceptance and the contributor toolchain table", () => {
  const declared = toolchain.match(/^BUN_VERSION=(\S+)$/m)?.[1];
  assert.match(declared ?? "", /^\d+\.\d+\.\d+$/);
  assert.ok(read("tools/run-acceptance.sh").includes(`test "$(bun --version)" = ${declared}`));
  assert.ok(read("tools/bootstrap.sh").includes(`test "$(bun --version)" = ${declared}`));
  assert.ok(read("CONTRIBUTING.md").includes(`| Bun | ${declared} |`));
});

test("every download is pinned by digest and verified before use", () => {
  for (const name of ["NODE_SHA256", "BUN_SHA256"]) {
    assert.match(toolchain.match(new RegExp(`^${name}=(\\S+)$`, "m"))?.[1] ?? "", /^[a-f0-9]{64}$/);
  }
  assert.ok(toolchain.includes('verify "$DEST/node.tar.xz" "$NODE_SHA256"'));
  assert.ok(toolchain.includes('verify "$DEST/bun.zip" "$BUN_SHA256"'));
  assert.ok(toolchain.includes("sha256sum"));
  // Neither a weakened transport nor an unreviewed remote script may stand in
  // for the digest check.
  assert.doesNotMatch(toolchain, /--insecure|-k\b|curl[^|\n]*\|\s*(ba)?sh|GIT_SSL_NO_VERIFY/);
});

test("the fetcher stays a host-only helper with no credentials or publication", () => {
  assert.doesNotMatch(toolchain, /npm publish|BROWSERBASE_API_KEY|secrets\.|id-token|git push/);
  // Default destination stays inside the ignored workspace directory.
  assert.ok(toolchain.includes('DEST="${1:-$ROOT/.work/toolchain}"'));
  assert.ok(read(".gitignore").includes(".work/"));
});
