import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { persistState, restoreState } from "../src/state.ts";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const git = (directory, args, input) =>
  execFileSync("git", args, {
    cwd: directory,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ts-release-state-test-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  await mkdir(remote);
  git(remote, ["init", "--bare", "--template=", "."]);
  const content = new Uint8Array([0, 1, 2, 255]);
  const files = new Map([
    ["bundle.json", new TextEncoder().encode('{"exact":"prepared"}\n')],
    ["plan.json", new TextEncoder().encode('{"plan":"immutable"}\n')],
    [digest(content), content],
  ]);
  return { root, files, remote, ref: `refs/heads/ts-release-prepared/${"a".repeat(40)}` };
}

async function withGitShim(root, body, run) {
  const bin = join(root, "bin"),
    originalPath = process.env.PATH,
    executable = Bun.which("git");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
${body}
if (args[0] !== "ls-remote") execFileSync(${JSON.stringify(executable)}, args, { stdio: "inherit" });
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
  }
}

test("retains a complete flat parentless snapshot and restores exact owned bytes", async () => {
  const value = await fixture();
  const expected = new Map([...value.files].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
  const pending = Effect.runPromise(persistState(value, value.files));
  // The caller may change its inputs while Git is running; retained bytes are owned.
  value.files.get("plan.json").fill(0);
  value.files.delete([...value.files.keys()].find((name) => name.length === 64));
  assert.equal(await pending, undefined);
  const commit = git(value.remote, ["rev-parse", value.ref]);
  assert.equal(git(value.remote, ["rev-list", "--parents", "-1", value.ref]), commit);
  assert.equal(git(value.remote, ["for-each-ref", "--format=%(refname)"]), value.ref);
  const restored = await Effect.runPromise(restoreState(value));
  assert.deepEqual([...restored.keys()].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected) assert.deepEqual(new Uint8Array(restored.get(name)), bytes);
});

test("only exact absent refs return undefined; remote failures and invalid coordinates reject", async () => {
  const value = await fixture();
  await Effect.runPromise(persistState(value, value.files));
  assert.equal(
    await Effect.runPromise(
      restoreState({
        ...value,
        ref: `refs/heads/ts-release-prepared/${"b".repeat(40)}`,
      }),
    ),
    undefined,
  );
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, remote: join(value.root, "missing") })),
  );
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, remote: "https://elsewhere.invalid/repo.git" })),
    /repository HTTPS/,
  );
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, ref: "refs/heads/main" })),
    /Invalid prepared-state ref/,
  );
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, ref: value.ref + "\n" })),
    /Invalid prepared-state ref/,
  );
});

test("concurrent identical snapshots have one winner and an existing ref is never replaced", async () => {
  const value = await fixture();
  const results = await Promise.allSettled([
    Effect.runPromise(persistState(value, value.files)),
    Effect.runPromise(persistState(value, value.files)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const commit = git(value.remote, ["rev-parse", value.ref]);
  value.files.set("plan.json", new TextEncoder().encode("changed\n"));
  await assert.rejects(Effect.runPromise(persistState(value, value.files)), /already exists/);
  assert.equal(git(value.remote, ["rev-parse", value.ref]), commit);
});

test("invalid names, incomplete snapshots and excess payload fail before creating a ref", async () => {
  const value = await fixture();
  for (const name of [
    "../outside",
    "content/nested",
    ".git",
    "metadata.json",
    "f".repeat(63),
    "f".repeat(64) + "\n",
  ]) {
    const files = new Map(value.files).set(name, new Uint8Array());
    await assert.rejects(Effect.runPromise(persistState(value, files)), /flat content digests/);
  }
  const missing = new Map(value.files);
  missing.delete("plan.json");
  await assert.rejects(Effect.runPromise(persistState(value, missing)), /bundle.json, plan.json/);
  const large = new Uint8Array(128 * 1024 * 1024 + 1);
  await assert.rejects(
    Effect.runPromise(persistState(value, new Map(value.files).set("f".repeat(64), large))),
    /128 MiB/,
  );
  const files = new Map([...value.files].filter(([name]) => name.endsWith(".json")));
  for (let index = 0; index < 5; index++)
    files.set(index.toString().repeat(64), large.subarray(0, 128 * 1024 * 1024));
  await assert.rejects(Effect.runPromise(persistState(value, files)), /512 MiB/);
  assert.equal(git(value.remote, ["for-each-ref", "--format=%(refname)"]), "");
});

test("remote snapshots cannot introduce links, executable modes, directories or extra names", async () => {
  for (const kind of ["symlink", "executable", "directory", "name", "missing"]) {
    const value = await fixture();
    const blob = git(value.remote, ["hash-object", "-w", "--stdin"], "untrusted bytes");
    const tree = git(value.remote, ["mktree"], "");
    const rows = [`100644 blob ${blob}\tbundle.json\n`];
    if (kind !== "missing") rows.push(`100644 blob ${blob}\tplan.json\n`);
    if (kind === "symlink") rows.push(`120000 blob ${blob}\t${"f".repeat(64)}\n`);
    if (kind === "executable") rows.push(`100755 blob ${blob}\t${"f".repeat(64)}\n`);
    if (kind === "directory") rows.push(`040000 tree ${tree}\t${"f".repeat(64)}\n`);
    if (kind === "name") rows.push(`100644 blob ${blob}\tunexpected.json\n`);
    const rootTree = git(value.remote, ["mktree"], rows.join(""));
    const commit = git(value.remote, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit-tree",
      rootTree,
      "-m",
      "fixture",
    ]);
    git(value.remote, ["update-ref", value.ref, commit]);
    await assert.rejects(
      Effect.runPromise(restoreState(value)),
      /unsupported entry|invalid or duplicate name|requires bundle/,
    );
  }
});

test("credentials are absent from committed state and command failures", async () => {
  const value = await fixture(),
    token = "not-a-real-secret-fixture";
  await Effect.runPromise(persistState({ ...value, token: Redacted.make(token) }, value.files));
  assert.ok(!git(value.remote, ["show", "--format=fuller", "--patch", value.ref]).includes(token));
  assert.ok(!(await readFile(join(value.remote, "config"), "utf8")).includes(token));
  const invalid = join(value.root, "not-a-repository");
  await mkdir(invalid);
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, remote: invalid, token: Redacted.make(token) })),
    (error) => {
      assert.ok(!String(error).includes(token));
      assert.ok(!JSON.stringify(error).includes(token));
      return true;
    },
  );
});

test("GitHub authorization is scoped environment data and excluded from command errors", async () => {
  const value = await fixture(),
    token = "dummy-token-exclusion-test";
  const capture = join(value.root, "git-call.json");
  await withGitShim(
    value.root,
    `
if (args[0] === "ls-remote") {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG_"))) }));
  process.stderr.write(${JSON.stringify(token)});
  process.exit(9);
}`,
    async () => {
      await assert.rejects(
        Effect.runPromise(
          restoreState({
            ...value,
            remote: "https://github.com/mannyc2/effect-agent-browserbase.git",
            token: Redacted.make(token),
          }),
        ),
        (error) => {
          assert.ok(!String(error).includes(token));
          assert.ok(!JSON.stringify(error).includes(token));
          return true;
        },
      );
    },
  );
  const call = JSON.parse(await readFile(capture, "utf8"));
  assert.ok(!JSON.stringify(call.args).includes(token));
  const headerEntry = Object.entries(call.env).find(
    ([key, entry]) =>
      key.startsWith("GIT_CONFIG_KEY_") &&
      entry === "http.https://github.com/mannyc2/effect-agent-browserbase.git.extraheader",
  );
  const index = headerEntry[0].slice("GIT_CONFIG_KEY_".length);
  assert.equal(
    call.env[`GIT_CONFIG_VALUE_${index}`],
    `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  );
});

test("interrupting Git kills the pending command and removes its temporary repository", async () => {
  const value = await fixture(),
    capture = join(value.root, "pending.json");
  await withGitShim(
    value.root,
    `
if (args[0] === "ls-remote") {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ directory: process.cwd(), pid: process.pid }));
  setInterval(() => {}, 1000);
}`,
    async () => {
      const controller = new AbortController();
      const pending = Effect.runPromise(restoreState(value), { signal: controller.signal }).catch(
        (error) => error,
      );
      let started;
      for (let attempt = 0; attempt < 200 && !started; attempt++) {
        try {
          started = JSON.parse(await readFile(capture, "utf8"));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      controller.abort();
      assert.ok(started, "fixture must reach a pending Git command");
      const interrupted = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000)),
      ]);
      assert.notEqual(interrupted, "timeout");
      await assert.rejects(access(started.directory), { code: "ENOENT" });
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(started.pid, 0);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
    },
  );
});
