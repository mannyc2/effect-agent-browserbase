import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Effect, Redacted, Schema, type Scope } from "effect";

export interface StateOptions {
  readonly remote: string;
  readonly ref: string;
  readonly directory: string;
  readonly token?: Redacted.Redacted<string>;
}

export class PreparedStateError extends Schema.TaggedError<PreparedStateError>()(
  "PreparedStateError",
  {
    message: Schema.String,
  },
) {}

interface StateFile {
  readonly path: string;
  readonly size: number;
  readonly mode: "100644" | "100755";
}
interface TreeFile extends StateFile {
  readonly blob: string;
}
interface GitResult {
  readonly status: number;
  readonly stdout: Buffer;
}
interface GitOptions {
  readonly accept?: readonly number[];
  readonly maxBuffer?: number;
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
  readonly directory: string;
}

const productionRemote = "https://github.com/mannyc2/effect-agent-browserbase.git";
const maximumBytes = 512 * 1024 * 1024;
const maximumFiles = 10_000;
const maximumListingBytes = 16 * 1024 * 1024;
const failure = (message: string) => new PreparedStateError({ message });
const requireState = (condition: unknown, message: string) =>
  condition ? Effect.void : failure(message);

// Keep native errors, paths and credential-bearing process details out of reports.
const io = <A>(message: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => failure(message),
  });

const checkPath = (path: string) =>
  requireState(
    path &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "Prepared state contains an unsafe path",
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
    (args: readonly string[], { accept = [0], maxBuffer = maximumListingBytes }: GitOptions = {}) =>
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
            execFile("git", args, options, (error, stdout) => {
              const status = error ? error.code : 0;
              if (typeof status !== "number" || !accept.includes(status)) {
                const code = typeof status === "number" ? status : "execution";
                reject(failure(`Prepared-state git ${args[0]} failed (${code})`));
              } else {
                resolveResult({ status, stdout });
              }
            });
          }),
        catch: (error) =>
          error instanceof PreparedStateError
            ? error
            : failure("Prepared-state Git execution failed"),
      }),
  );

const openRepository = Effect.fn("preparedState.openRepository")(function* (options: StateOptions) {
  yield* requireState(
    /^refs\/heads\/ts-release-prepared\/[a-f0-9]{40}$/.test(options.ref),
    "Invalid prepared-state ref",
  );
  yield* requireState(
    options.remote === productionRemote || isAbsolute(options.remote),
    "Prepared state requires the repository HTTPS remote or an absolute local remote",
  );
  yield* requireState(options.directory.length > 0, "Prepared state requires a directory");
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
    directory: resolve(options.directory),
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

const sourceFiles = Effect.fn("preparedState.sourceFiles")(function* (directory: string) {
  const root = yield* io("Could not inspect prepared-state directory", () => lstat(directory));
  yield* requireState(root.isDirectory(), "Prepared state must be a regular directory");
  const files: StateFile[] = [];
  const pending = [""];
  let size = 0;
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const entries = yield* io("Could not list prepared-state directory", () =>
      readdir(join(directory, relative), { withFileTypes: true }),
    );
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      yield* checkPath(path);
      const info = yield* io("Could not inspect prepared-state file", () =>
        lstat(join(directory, path)),
      );
      if (info.isDirectory()) pending.push(path);
      else {
        yield* requireState(
          info.isFile(),
          "Prepared state may contain only directories and regular files",
        );
        size += info.size;
        yield* requireState(size <= maximumBytes, "Prepared state exceeds 512 MiB");
        files.push({ path, size: info.size, mode: info.mode & 0o111 ? "100755" : "100644" });
        yield* requireState(files.length <= maximumFiles, "Prepared state contains too many files");
      }
    }
  }
  yield* requireState(files.length > 0, "Prepared state must not be empty");
  return files;
});

const snapshotFile = Effect.fn("preparedState.snapshotFile")(function* (
  repository: Repository,
  file: StateFile,
): Effect.fn.Return<void, PreparedStateError, Scope.Scope> {
  const changed = "Prepared state changed while being persisted";
  // Each file has its own scope, so large snapshots do not retain open handles.
  const input = yield* Effect.acquireRelease(
    io("Could not open prepared-state file", () =>
      open(join(repository.directory, file.path), constants.O_RDONLY | constants.O_NOFOLLOW),
    ),
    (handle) => io("Could not close prepared-state file", () => handle.close()).pipe(Effect.orDie),
  );
  const info = yield* io("Could not inspect prepared-state file", () => input.stat());
  yield* requireState(info.isFile() && info.size === file.size, changed);
  const bytes = Buffer.alloc(file.size);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = yield* io("Could not read prepared-state file", () =>
      input.read(bytes, offset, bytes.length - offset, offset),
    );
    yield* requireState(bytesRead > 0, changed);
    offset += bytesRead;
  }
  const trailing = yield* io("Could not check prepared-state file length", () =>
    input.read(Buffer.alloc(1), 0, 1, offset),
  );
  yield* requireState(trailing.bytesRead === 0, changed);
  const snapshot = join(repository.path, "state-blob");
  yield* io("Could not write prepared-state snapshot", (signal) =>
    writeFile(snapshot, bytes, { mode: 0o600, signal }),
  );
  const blob = (yield* repository.git(["hash-object", "-w", "--no-filters", "--", snapshot])).stdout
    .toString("utf8")
    .trim();
  yield* repository.git(["update-index", "--add", "--cacheinfo", file.mode, blob, file.path]);
}, Effect.scoped);

/** Store a complete prepared release on a new parentless ref; never update one. */
export const persistState = Effect.fn("preparedState.persistState")(function* (
  options: StateOptions,
): Effect.fn.Return<string, PreparedStateError, Scope.Scope> {
  const repository = yield* openRepository(options);
  const { git, ref, remote } = repository;
  yield* requireState(
    (yield* remoteCommit(repository)) === undefined,
    "Prepared-state ref already exists; restore it instead of replacing it",
  );
  for (const file of yield* sourceFiles(repository.directory)) {
    yield* snapshotFile(repository, file);
  }
  const tree = (yield* git(["write-tree"])).stdout.toString("utf8").trim();
  // Unique commits make identical competing snapshots contend instead of being
  // treated as an already-up-to-date successful push.
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
  return commit;
}, Effect.scoped);

const readTree = Effect.fn("preparedState.readTree")(function* (git: Git, commit: string) {
  const listing = (yield* git(["ls-tree", "-r", "-z", "-l", "--full-tree", commit])).stdout;
  const text = listing.toString("utf8");
  yield* requireState(text.length > 0, "Prepared state must not be empty");
  yield* requireState(
    Buffer.from(text).equals(listing),
    "Prepared state paths must be valid UTF-8",
  );
  const files: TreeFile[] = [];
  let total = 0;
  for (const record of text.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match)
      return yield* failure("Prepared state contains a symlink, submodule or unsupported entry");
    const path = match[4]!;
    yield* checkPath(path);
    const size = Number(match[3]);
    total += size;
    yield* requireState(
      Number.isSafeInteger(size) && total <= maximumBytes,
      "Prepared state exceeds 512 MiB",
    );
    files.push({ path, size, blob: match[2]!, mode: match[1] === "100755" ? "100755" : "100644" });
    yield* requireState(files.length <= maximumFiles, "Prepared state contains too many files");
  }
  return files;
});

/** Restore exact committed bytes into an empty directory, without executing them. */
export const restoreState = Effect.fn("preparedState.restoreState")(function* (
  options: StateOptions,
): Effect.fn.Return<boolean, PreparedStateError, Scope.Scope> {
  const repository = yield* openRepository(options);
  const { git, directory, remote } = repository;
  yield* io("Could not create prepared-state destination", () =>
    mkdir(directory, { recursive: true }),
  );
  const destination = yield* io("Could not inspect prepared-state destination", () =>
    lstat(directory),
  );
  yield* requireState(
    destination.isDirectory(),
    "Prepared-state destination must be a regular directory",
  );
  const entries = yield* io("Could not list prepared-state destination", () => readdir(directory));
  yield* requireState(entries.length === 0, "Prepared-state destination must be empty");
  const commit = yield* remoteCommit(repository);
  if (commit === undefined) return false;
  // Fetch the observed immutable object, never a ref that could change meanwhile.
  yield* git(["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", remote, commit]);
  const identity = (yield* git(["rev-parse", "FETCH_HEAD^{commit}"])).stdout
    .toString("utf8")
    .trim();
  yield* requireState(identity === commit, "Prepared-state commit changed during fetch");
  for (const file of yield* readTree(git, commit)) {
    const bytes = (yield* git(["cat-file", "blob", file.blob], {
      maxBuffer: Math.max(file.size + 1, 1024),
    })).stdout;
    yield* requireState(
      bytes.length === file.size,
      "Prepared-state blob size differs from its tree",
    );
    const segments = file.path.split("/");
    segments.pop();
    yield* io("Could not create restored prepared-state directory", () =>
      mkdir(join(directory, ...segments), { recursive: true }),
    );
    yield* io("Could not restore prepared-state file", (signal) =>
      writeFile(join(directory, file.path), bytes, {
        flag: "wx",
        mode: file.mode === "100755" ? 0o755 : 0o644,
        signal,
      }),
    );
  }
  return true;
}, Effect.scoped);
