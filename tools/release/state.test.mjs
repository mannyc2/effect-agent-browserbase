import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { persistState, restoreState } from "./state.ts";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const git = (directory, ...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ts-release-state-test-"));
  directories.push(root);
  const remote = join(root, "remote.git");
  const directory = join(root, "source");
  await mkdir(remote);
  git(remote, "init", "--bare", "--template=", ".");
  await mkdir(join(directory, "content"), { recursive: true });
  await writeFile(join(directory, "bundle.json"), '{"exact":"prepared"}\n');
  await writeFile(join(directory, "plan.json"), '{"plan":"immutable"}\n');
  await writeFile(join(directory, "content", "package.tgz"), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(directory, ".metadata"), "hidden files are included\n");
  return { root, remote, directory, ref: `refs/heads/ts-release-prepared/${"a".repeat(40)}` };
}

test("prepared state is a complete parentless immutable snapshot and restores exact bytes", async () => {
  const value = await fixture();
  const commit = await Effect.runPromise(persistState(value));
  assert.equal(git(value.remote, "rev-list", "--parents", "-1", value.ref), commit);
  assert.equal(git(value.remote, "for-each-ref", "--format=%(refname)"), value.ref);
  const directory = join(value.root, "restored");
  assert.equal(await Effect.runPromise(restoreState({ ...value, directory })), true);
  assert.deepEqual((await readdir(directory)).sort(), [
    ".metadata",
    "bundle.json",
    "content",
    "plan.json",
  ]);
  for (const file of [".metadata", "bundle.json", "plan.json", "content/package.tgz"]) {
    assert.deepEqual(
      await readFile(join(directory, file)),
      await readFile(join(value.directory, file)),
    );
  }
});

test("only exact absent refs return false; remote failures and invalid input reject", async () => {
  const value = await fixture();
  await Effect.runPromise(persistState(value));
  const directory = join(value.root, "absent");
  const absent = await Effect.runPromise(
    restoreState({
      ...value,
      ref: `refs/heads/ts-release-prepared/${"b".repeat(40)}`,
      directory,
    }),
  );
  assert.equal(absent, false);
  await assert.rejects(
    Effect.runPromise(
      restoreState({
        ...value,
        remote: join(value.root, "missing"),
        directory,
      }),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      restoreState({
        ...value,
        remote: "https://elsewhere.invalid/repo.git",
        directory,
      }),
    ),
    /repository HTTPS/,
  );
  await assert.rejects(
    Effect.runPromise(
      restoreState({
        ...value,
        ref: "refs/heads/main",
        directory,
      }),
    ),
    /Invalid prepared-state ref/,
  );
  await assert.rejects(Effect.runPromise(restoreState(value)), /destination must be empty/);
});

test("an existing prepared ref is never overwritten and concurrent creation has one winner", async () => {
  const value = await fixture();
  const results = await Promise.allSettled([
    Effect.runPromise(persistState(value)),
    Effect.runPromise(persistState(value)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const commit = git(value.remote, "rev-parse", value.ref);
  await writeFile(join(value.directory, "plan.json"), "changed\n");
  await assert.rejects(Effect.runPromise(persistState(value)), /already exists/);
  assert.equal(git(value.remote, "rev-parse", value.ref), commit);
});

test("credentials are absent from committed state and command failures", async () => {
  const value = await fixture();
  const token = "not-a-real-secret-fixture";
  await Effect.runPromise(persistState({ ...value, token: Redacted.make(token) }));
  const dump = git(value.remote, "show", "--format=fuller", "--patch", value.ref);
  assert.ok(!dump.includes(token));
  assert.ok(!(await readFile(join(value.remote, "config"), "utf8")).includes(token));
  const invalid = join(value.root, "not-a-repository");
  await mkdir(invalid);
  await assert.rejects(
    Effect.runPromise(
      restoreState({
        ...value,
        remote: invalid,
        directory: join(value.root, "failed"),
        token: Redacted.make(token),
      }),
    ),
    (error) => {
      assert.ok(!String(error).includes(token));
      assert.ok(!JSON.stringify(error).includes(token));
      return true;
    },
  );
});

test("unsafe source entries and excessive payload are rejected before a ref is created", async () => {
  const value = await fixture();
  await symlink("bundle.json", join(value.directory, "link"));
  await assert.rejects(
    Effect.runPromise(persistState(value)),
    /only directories and regular files/,
  );
  await rm(join(value.directory, "link"));
  await writeFile(join(value.directory, "large"), "");
  await truncate(join(value.directory, "large"), 512 * 1024 * 1024 + 1);
  await assert.rejects(Effect.runPromise(persistState(value)), /512 MiB/);
  assert.equal(git(value.remote, "for-each-ref", "--format=%(refname)"), "");
});

test("restore rejects a committed symlink before materializing any files", async () => {
  const value = await fixture();
  const work = join(value.root, "malicious");
  await mkdir(work);
  git(work, "init", "--template=", ".");
  git(work, "config", "user.name", "fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(work, "ordinary"), "must not be restored\n");
  await symlink("../outside", join(work, "unsafe"));
  git(work, "add", ".");
  git(work, "commit", "-m", "unsafe fixture");
  git(work, "push", value.remote, `HEAD:${value.ref}`);
  const directory = join(value.root, "restored");
  await assert.rejects(
    Effect.runPromise(restoreState({ ...value, directory })),
    /symlink, submodule/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test("GitHub authorization is scoped environment data and is excluded from command errors", async () => {
  const value = await fixture();
  const token = "dummy-token-exclusion-test";
  const capture = join(value.root, "git-call.json");
  const bin = join(value.root, "bin");
  const originalPath = process.env.PATH;
  const executable = Bun.which("git");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "ls-remote") {
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG_"))) }));
  process.stderr.write(${JSON.stringify(token)});
  process.exit(9);
}
execFileSync(${JSON.stringify(executable)}, args, { stdio: "inherit" });
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    await assert.rejects(
      Effect.runPromise(
        restoreState({
          ...value,
          remote: "https://github.com/mannyc2/effect-agent-browserbase.git",
          directory: join(value.root, "restored"),
          token: Redacted.make(token),
        }),
      ),
      (error) => {
        assert.ok(!String(error).includes(token));
        assert.ok(!JSON.stringify(error).includes(token));
        return true;
      },
    );
  } finally {
    process.env.PATH = originalPath;
  }
  const call = JSON.parse(await readFile(capture, "utf8"));
  assert.ok(!JSON.stringify(call.args).includes(token));
  const headerEntry = Object.entries(call.env).find(
    ([key, entry]) =>
      key.startsWith("GIT_CONFIG_KEY_") &&
      entry === "http.https://github.com/mannyc2/effect-agent-browserbase.git.extraheader",
  );
  const headerIndex = headerEntry[0].slice("GIT_CONFIG_KEY_".length);
  const expectedHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  assert.equal(call.env[`GIT_CONFIG_VALUE_${headerIndex}`], expectedHeader);
});
