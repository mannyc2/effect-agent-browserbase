// rc.115's NodeChildProcessSpawner exposes leader exit, but its bounded group wait can
// succeed with surviving members. This boundary must observe the leader AND group gone.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, type ChildProcess } from "node:child_process";
// FileSystem.remove exposes recursive/force only, not rm's per-entry OS-error retries.
// Keep native profile creation/read/removal together; removal follows confirmed group exit.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { Clock, Duration, Effect, Exit, Path, Redacted, Schema } from "effect";

import { BrowserError } from "../../Errors.ts";
import { LocalEndpoint, type LocalLaunch } from "./LocalData.ts";

export interface LocalProcess {
  readonly connection: (
    timeoutMillis: number,
  ) => Effect.Effect<Redacted.Redacted<string>, BrowserError>;
  readonly terminate: Effect.Effect<void, BrowserError>;
  readonly removeProfile: Effect.Effect<void, BrowserError>;
}

/** Explicit host sandbox/proxy choices; the owned profile and debugger endpoint cannot be replaced. */
export const launchArguments = (options: LocalLaunch, directory: string): string[] => [
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--user-data-dir=${directory}`,
  ...(options.headless === false ? [] : ["--headless=new"]),
  ...(options.chromiumSandbox === false ? ["--no-sandbox"] : []),
  ...(options.proxy === undefined
    ? []
    : [
        `--proxy-server=${options.proxy.server}`,
        // Chromium otherwise bypasses proxies for loopback. The host may deliberately override it.
        `--proxy-bypass-list=${options.proxy.bypass ?? "<-loopback>"}`,
      ]),
  ...(options.args ?? []),
  "about:blank",
];

const failure = (operation: "launch" | "connect" | "close", reason: BrowserError["reason"]) =>
  BrowserError.make({
    operation,
    reason,
    outcome: operation === "close" ? "unknown" : "undispatched",
  });

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** POSIX groups keep Chromium's helpers inside the same owned termination boundary. */
const alive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
};

/** Called once; observes parent and helper exit, rather than treating a sent signal as cleanup. */
const terminate = Effect.fnUntraced(function* (
  child: ChildProcess,
  pid: number,
  clock: Clock.Clock,
): Effect.fn.Return<void, BrowserError> {
  const stopped = Effect.try({
    try: () => exited(child) && !alive(pid),
    catch: () => failure("close", "failed"),
  });

  const signal = (value: NodeJS.Signals) =>
    Effect.try({ try: () => signalGroup(pid, value), catch: () => failure("close", "failed") });

  const pause = clock.sleep(Duration.millis(20));

  yield* signal("SIGTERM");
  const graceful = clock.monotonicTimeNanosUnsafe() + 1_500_000_000n;

  while (!(yield* stopped) && clock.monotonicTimeNanosUnsafe() < graceful) yield* pause;
  if (yield* stopped) return;
  yield* signal("SIGKILL");
  const forced = clock.monotonicTimeNanosUnsafe() + 1_000_000_000n;

  while (!(yield* stopped) && clock.monotonicTimeNanosUnsafe() < forced) yield* pause;
  if (!(yield* stopped)) return yield* failure("close", "timeout");
});

/** Start only Chromium's process. The shared owner later opens its sole CDP connection. */
export const launch = Effect.fnUntraced(function* (
  options: LocalLaunch,
): Effect.fn.Return<LocalProcess, BrowserError> {
  if (process.platform === "win32") return yield* failure("launch", "unsupported");
  const path = yield* Path.Path.pipe(Effect.provide(Path.layer));
  const clock = yield* Clock.Clock;

  const executable =
    options.executablePath ??
    (yield* Effect.tryPromise({
      try: async () => (await import("playwright-core")).chromium.executablePath(),
      catch: () => failure("launch", "failed"),
    }));

  const directory = yield* Effect.tryPromise({
    try: () => mkdtemp(path.join(tmpdir(), "effect-local-browser-")),
    catch: () => failure("launch", "failed"),
  });

  const removeProfile = Effect.tryPromise({
    try: () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    catch: () => failure("close", "failed"),
  });

  let child: ChildProcess | undefined;

  return yield* Effect.gen(function* () {
    const launched = yield* Effect.tryPromise({
      try: () => {
        const spawned = spawn(executable, launchArguments(options, directory), {
          cwd: directory,
          stdio: ["ignore", "ignore", "ignore"],
          detached: true,
        });

        child = spawned;

        return new Promise<ChildProcess>((resolve, reject) => {
          spawned.once("spawn", () => resolve(spawned));
          spawned.once("error", reject);
        });
      },
      catch: () => failure("launch", "failed"),
    });

    const pid = launched.pid;

    if (pid === undefined) return yield* failure("launch", "failed");

    // One termination continues to its own bounded group-exit decision even if a waiter cancels.
    const closing = yield* Effect.cached(
      terminate(launched, pid, clock).pipe(Effect.uninterruptible),
    );

    return {
      connection: (timeoutMillis) =>
        Effect.gen(function* () {
          const deadline =
            clock.monotonicTimeNanosUnsafe() +
            BigInt(Math.ceil(Math.min(timeoutMillis, options.startupTimeoutMillis ?? 15000))) *
              1_000_000n;

          while (clock.monotonicTimeNanosUnsafe() < deadline) {
            if (exited(launched)) return yield* failure("connect", "closed");

            const portFile = yield* Effect.tryPromise({
              try: (signal) =>
                readFile(path.join(directory, "DevToolsActivePort"), {
                  encoding: "utf8",
                  signal,
                }).catch((error: unknown) => {
                  if (error instanceof Error && "code" in error && error.code === "ENOENT")
                    return undefined;
                  throw error;
                }),
              catch: () => failure("connect", "transport"),
            });

            // Chromium creates DevToolsActivePort before it writes the port and path into it. A
            // file without both lines is startup still in progress, not an endpoint; only a
            // complete file that is not a loopback DevTools endpoint is malformed.
            const lines = portFile === undefined ? [] : portFile.trim().split("\n");

            if (lines.length >= 2) {
              const endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;

              if (!Schema.is(LocalEndpoint)(endpoint))
                return yield* failure("connect", "malformed");

              return Redacted.make(endpoint);
            }
            yield* clock.sleep(Duration.millis(20));
          }

          return yield* failure("connect", "timeout");
        }),
      terminate: closing,
      removeProfile,
    } satisfies LocalProcess;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.gen(function* () {
            if (child?.pid === undefined) {
              yield* removeProfile.pipe(Effect.ignore);

              return;
            }
            const stopped = yield* terminate(child, child.pid, clock).pipe(Effect.exit);

            if (Exit.isSuccess(stopped)) yield* removeProfile.pipe(Effect.ignore);
          }),
    ),
  );
});
