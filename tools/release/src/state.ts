import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect, Redacted, Schema, type Scope } from "effect";
import { remote as productionRemote } from "./config.js";

export interface StateOptions {
  readonly remote: string;
  readonly ref: string;
  readonly token?: Redacted.Redacted<string>;
}

export class PreparedStateError extends Schema.TaggedError<PreparedStateError>()(
  "PreparedStateError",
  {
    message: Schema.String,
  },
) {}

interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
}
interface GitOptions {
  readonly accept?: readonly number[];
  readonly maxBuffer?: number;
  readonly input?: string;
}
type Git = (
  args: readonly string[],
  options?: GitOptions,
) => Effect.Effect<GitResult, PreparedStateError>;
interface Repository {
  readonly git: Git;
  readonly path: string;
  readonly remote: string;
  readonly ref: string;
}

const preparedRefPrefix = "refs/heads/ts-release-prepared/";
const maximumBytes = 512 * 1024 * 1024;
const maximumBlobBytes = 128 * 1024 * 1024;
const maximumFiles = 7;
const maximumListingBytes = 64 * 1024;
const failure = (message: string) => new PreparedStateError({ message });
const requireState = (condition: unknown, message: string) =>
  condition ? Effect.void : failure(message);

// Keep native errors, paths and credential-bearing process details out of reports.
const io = <A>(message: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => failure(message),
  });

const validName = (name: string) =>
  name === "bundle.json" ||
  name === "plan.json" ||
  (name.length === 64 && /^[a-f0-9]{64}$/.test(name));

const checkInventory = (files: ReadonlyMap<string, unknown>) =>
  requireState(
    files.has("bundle.json") &&
      files.has("plan.json") &&
      files.size <= maximumFiles &&
      [...files.keys()].every(validName),
    "Prepared state requires bundle.json, plan.json and at most five flat content digests",
  );

const gitEnvironment = Effect.fn("preparedState.gitEnvironment")(function* (
  remote: string,
  token?: Redacted.Redacted<string>,
) {
  // Ignore caller Git helpers, tracing and repository selection. Authorization is
  // scoped to this remote and lives only in the child environment, never argv/config.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const config: [string, string][] = [
    ["user.name", "ts-release prepared state"],
    ["user.email", "ts-release@users.noreply.github.com"],
    ["core.hooksPath", "/dev/null"],
    ["core.autocrlf", "false"],
    ["credential.helper", ""],
    ["protocol.ext.allow", "never"],
    ["http.followRedirects", "false"],
  ];
  if (token !== undefined) {
    const value = yield* Effect.try({
      try: () => Redacted.value(token),
      catch: () => failure("Invalid prepared-state credential"),
    });
    yield* requireState(
      typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value),
      "Invalid prepared-state credential",
    );
    if (remote === productionRemote) {
      config.push([
        `http.${productionRemote}.extraheader`,
        `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${value}`).toString("base64")}`,
      ]);
    }
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(config.length),
  });
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
});

const gitCommand = (directory: string, env: NodeJS.ProcessEnv): Git =>
  Effect.fn("preparedState.gitCommand")(
    (
      args: readonly string[],
      { accept = [0], maxBuffer = maximumListingBytes, input }: GitOptions = {},
    ) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<GitResult>((resolveResult, reject) => {
            const options = {
              cwd: directory,
              env,
              encoding: "buffer" as const,
              timeout: 120_000,
              maxBuffer,
              killSignal: "SIGKILL" as const,
              signal,
            };
            const child = execFile("git", args, options, (error, stdout) => {
              const status = error ? error.code : 0;
              if (typeof status !== "number" || !accept.includes(status)) {
                const code = typeof status === "number" ? status : "execution";
                reject(failure(`Prepared-state git ${args[0]} failed (${code})`));
              } else {
                resolveResult({ status, stdout });
              }
            });
            if (input !== undefined) {
              child.stdin?.once("error", () =>
                reject(failure("Could not send prepared state to Git")),
              );
              child.stdin?.end(input);
            }
          }),
        catch: (error) =>
          error instanceof PreparedStateError
            ? error
            : failure("Prepared-state Git execution failed"),
      }),
  );

const openRepository = Effect.fn("preparedState.openRepository")(function* (options: StateOptions) {
  yield* requireState(
    options.ref.length === preparedRefPrefix.length + 40 &&
      /^refs\/heads\/ts-release-prepared\/[a-f0-9]{40}$/.test(options.ref),
    "Invalid prepared-state ref",
  );
  yield* requireState(
    options.remote === productionRemote || isAbsolute(options.remote),
    "Prepared state requires the repository HTTPS remote or an absolute local remote",
  );
  const remote =
    options.remote === productionRemote
      ? options.remote
      : yield* io("Prepared-state remote is unavailable", () => realpath(options.remote));
  const env = yield* gitEnvironment(remote, options.token);
  const temporary = yield* Effect.acquireRelease(
    io("Could not create prepared-state temporary directory", () =>
      mkdtemp(join(tmpdir(), "ts-release-state-")),
    ),
    (directory) =>
      io("Could not remove prepared-state temporary directory", () =>
        rm(directory, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  );
  const path = join(temporary, "repository");
  yield* io("Could not create prepared-state repository", () => mkdir(path));
  const git = gitCommand(path, env);
  yield* git(["init", "--bare", "--template=", "."]);
  return {
    git,
    path,
    remote,
    ref: options.ref,
  } satisfies Repository;
});

const remoteCommit = Effect.fn("preparedState.remoteCommit")(function* ({
  git,
  remote,
  ref,
}: Repository) {
  const { status, stdout } = yield* git(["ls-remote", "--exit-code", "--refs", "--", remote, ref], {
    accept: [0, 2],
  });
  if (status === 2 && stdout.length === 0) return undefined;
  const match = /^([a-f0-9]{40})\t([^\n]+)\n$/.exec(stdout.toString("utf8"));
  if (status !== 0 || !match || match[2] !== ref)
    return yield* failure("Prepared-state ref lookup was not exact");
  return match[1]!;
});

// Capture caller-owned bytes before the first Git effect. Storage does not invent
// a second content manifest: native Bundle loading verifies digest membership.
const ownSnapshot = Effect.fn("preparedState.ownSnapshot")(function* (
  files: ReadonlyMap<string, Uint8Array>,
) {
  yield* checkInventory(files);
  const sizes = [...files.values()].map((bytes) => bytes.byteLength);
  yield* requireState(
    sizes.every((size) => size <= maximumBlobBytes),
    "Prepared-state blob exceeds 128 MiB",
  );
  yield* requireState(
    sizes.reduce((total, size) => total + size, 0) <= maximumBytes,
    "Prepared state exceeds 512 MiB",
  );
  return new Map([...files].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
});

/** Retain only the native Bundle, Plan and their owned bytes on a new root ref. */
export const persistState = Effect.fn("preparedState.persistState")(function* (
  options: StateOptions,
  input: ReadonlyMap<string, Uint8Array>,
): Effect.fn.Return<void, PreparedStateError, Scope.Scope> {
  const files = yield* ownSnapshot(input);
  const repository = yield* openRepository(options);
  const { git, ref, remote } = repository;
  yield* requireState(
    (yield* remoteCommit(repository)) === undefined,
    "Prepared-state ref already exists; restore it instead of replacing it",
  );
  const entries: string[] = [];
  const snapshot = join(repository.path, "state-blob");
  for (const [name, bytes] of files) {
    yield* io("Could not stage prepared-state bytes", (signal) =>
      writeFile(snapshot, bytes, { mode: 0o600, signal }),
    );
    const blob = (yield* git(["hash-object", "-w", "--no-filters", "--", snapshot])).stdout
      .toString("utf8")
      .trim();
    entries.push(`100644 blob ${blob}\t${name}\n`);
  }
  const tree = (yield* git(["mktree"], { input: entries.join("") })).stdout.toString("utf8").trim();
  // A unique commit makes identical concurrent preparations contend too.
  const message = `Immutable prepared release ${ref.slice(ref.lastIndexOf("/") + 1)}\n\nPreparation: ${randomUUID()}`;
  const commit = (yield* git(["commit-tree", tree, "-m", message])).stdout.toString("utf8").trim();
  yield* git([
    "push",
    "--porcelain",
    `--force-with-lease=${ref}:`,
    "--",
    remote,
    `${commit}:${ref}`,
  ]);
}, Effect.scoped);

/** Read exact immutable bytes without checking out any remote paths or modes. */
export const restoreState = Effect.fn("preparedState.restoreState")(function* (
  options: StateOptions,
): Effect.fn.Return<ReadonlyMap<string, Uint8Array> | undefined, PreparedStateError, Scope.Scope> {
  const repository = yield* openRepository(options);
  const { git, remote } = repository;
  const commit = yield* remoteCommit(repository);
  if (commit === undefined) return undefined;
  yield* git(["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", remote, commit]);
  const identity = (yield* git(["rev-parse", "FETCH_HEAD^{commit}"])).stdout
    .toString("utf8")
    .trim();
  yield* requireState(identity === commit, "Prepared-state commit changed during fetch");
  const listing = (yield* git(["ls-tree", "-z", "-l", commit])).stdout.toString("utf8");
  const entries = new Map<string, { readonly blob: string; readonly size: number }>();
  let total = 0;
  for (const record of listing.split("\0").filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40}) +([0-9]+)\t([a-z0-9.]+)$/.exec(record);
    if (!match)
      return yield* failure("Prepared state contains a directory, link or unsupported entry");
    const name = match[3]!,
      size = Number(match[2]);
    yield* requireState(
      validName(name) && !entries.has(name),
      "Prepared state has an invalid or duplicate name",
    );
    yield* requireState(
      Number.isSafeInteger(size) && size <= maximumBlobBytes,
      "Prepared-state blob exceeds 128 MiB",
    );
    total += size;
    yield* requireState(total <= maximumBytes, "Prepared state exceeds 512 MiB");
    entries.set(name, { blob: match[1]!, size });
  }
  yield* checkInventory(entries);
  const files = new Map<string, Uint8Array>();
  for (const [name, { blob, size }] of entries) {
    const { stdout } = yield* git(["cat-file", "blob", blob], {
      maxBuffer: Math.max(size + 1, 1024),
    });
    yield* requireState(stdout.length === size, "Prepared-state blob size differs from its tree");
    files.set(name, stdout);
  }
  return files;
}, Effect.scoped);
