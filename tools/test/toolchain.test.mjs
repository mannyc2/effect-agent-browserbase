import assert from "node:assert/strict";
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
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

test("the Bun pin comes from the same file every other command asserts", () => {
  assert.ok(toolchain.includes('BUN_VERSION="$(cat "$ROOT/.bun-version")"'));
  const bunPin = read(".bun-version").trim();

  assert.match(bunPin, /^\d+\.\d+\.\d+$/);
  // A second copy of the version would drift away from the assertions silently.
  assert.ok(!toolchain.includes(bunPin), "Bun version must not be duplicated in the fetcher");
  assert.ok(
    read("tools/run-acceptance.sh").includes(
      'test "$(bun --version)" = "$(cat "$SOURCE_ROOT/.bun-version")"',
    ),
  );
  assert.ok(
    read("tools/bootstrap.sh").includes('test "$(bun --version)" = "$(cat "$ROOT/.bun-version")"'),
  );
  assert.ok(read("CONTRIBUTING.md").includes(`| Bun | ${bunPin} (\`.bun-version\`) |`));
  // CI must read the pin too rather than restating it next to the checkout.
  for (const workflow of [".github/workflows/ci.yml", ".github/workflows/hosted.yml"]) {
    assert.ok(read(workflow).includes("bun-version-file: .bun-version"));
    assert.ok(!read(workflow).includes(bunPin), `${workflow} must not duplicate the Bun version`);
  }
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

// Offline shell boundary tests. Executables below are explicit fixtures, not
// evidence that the real publisher assets were downloaded or executed.

const fixture = (t, downloadBody = "exit 6") => {
  const directory = mkdtempSync(join(tmpdir(), "browserbase-toolchain-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "fixtures-bin");
  mkdirSync(bin);
  mkdirSync(join(directory, "tools"));
  writeFileSync(join(directory, ".node-version"), read(".node-version"));
  writeFileSync(join(directory, ".bun-version"), read(".bun-version"));
  writeFileSync(join(directory, "tools/pinned-toolchain.sh"), toolchain);
  const executable = (path, body) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable(join(bin, "curl"), downloadBody);
  for (const name of ["tar", "unzip"])
    executable(join(bin, name), 'touch "$TEST_ROOT/extraction-attempted"; exit 97');
  const nodeVersion = read(".node-version").trim();
  const bunVersion = read(".bun-version").trim();
  const seed = (dest, { bun = true } = {}) => {
    executable(join(dest, `node-v${nodeVersion}-linux-x64/bin/node`), `echo v${nodeVersion}`);
    if (bun) executable(join(dest, `bun-${bunVersion}-linux-x64/bun`), `echo ${bunVersion}`);
  };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: directory };
  const run = (args, options = {}) => spawnSync("/bin/bash", args, {
    cwd: directory, env, encoding: "utf8", timeout: 10000, ...options,
  });
  return { directory, nodeVersion, bunVersion, seed, run };
};

const platform = process.platform === "linux" && process.arch === "x64";

test("cached pinned-version fixtures are reused without a download", { skip: !platform }, (t) => {
  const f = fixture(t, 'touch "$TEST_ROOT/download-attempted"; exit 96');
  const dest = join(f.directory, ".work/toolchain");
  f.seed(dest);
  const result = f.run(["tools/pinned-toolchain.sh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^export PATH=/);
  assert.equal(existsSync(join(f.directory, "download-attempted")), false);
});

test("a relative destination emits a stable escaped PATH after changing directories", { skip: !platform }, (t) => {
  const f = fixture(t);
  const relative = "cache with spaces and 'quote'";
  f.seed(join(f.directory, relative));
  const prepared = f.run(["tools/pinned-toolchain.sh", relative]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const activated = f.run(["-c", 'eval "$1"; cd /; node --version; bun --version', "activate", prepared.stdout]);
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(activated.stdout, `v${f.nodeVersion}\n${f.bunVersion}\n`);
});

test("the documented activation propagates a failed download instead of eval-empty success", { skip: !platform }, (t) => {
  const f = fixture(t);
  const command = read("CONTRIBUTING.md").match(/```sh\n([^\n]*pinned-toolchain\.sh[^\n]*)\n```/)?.[1];
  assert.ok(command, "The activation example must remain directly executable");
  const result = f.run(["-c", command]);
  assert.equal(result.status, 6, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(join(f.directory, "extraction-attempted")), false);
});

for (const target of ["Node", "Bun"]) {
  test(`${target} digest rejection occurs before extraction or PATH output`, { skip: !platform }, (t) => {
    const f = fixture(t, 'while test "$#" -gt 0; do if test "$1" = -o; then printf untrusted > "$2"; exit 0; fi; shift; done; exit 98');
    if (target === "Bun") f.seed(join(f.directory, ".work/toolchain"), { bun: false });
    const result = f.run(["tools/pinned-toolchain.sh"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Digest mismatch/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(f.directory, "extraction-attempted")), false);
  });
}
