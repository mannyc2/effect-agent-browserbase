import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";

import { BrowserPolicy } from "../src/BrowserData.ts";
import { LocalBrowser, type LocalCleanupResult } from "../src/LocalBrowser.ts";

/**
 * A process that starts but never advertises CDP exposes cancellation without launching a browser.
 * With `portFile`, it first writes that content to its profile's DevToolsActivePort, the way Chromium
 * leaves the file between creating it and filling it.
 */
const stalledProcess = (portFile?: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "local-process-test-"));
      const executable = join(directory, "chromium-stalled");
      const pidFile = join(directory, "pid");
      const argsFile = join(directory, "args");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

      const advertise =
        portFile === undefined
          ? ""
          : `for a in "$@"; do case "$a" in --user-data-dir=*) d="\${a#--user-data-dir=}";; esac; done\nprintf '%s' ${quote(portFile)} > "$d/DevToolsActivePort"\n`;

      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nprintf '%s\\n' "$@" > ${quote(argsFile)}\n${advertise}exec sleep 30\n`,
        { mode: 0o700 },
      );

      return { directory, executable, pidFile, argsFile };
    }),
    (fixture) =>
      Effect.promise(async () => {
        // This fixture knows only its own process. Prevent a regression from leaving it behind.
        const pid = await readFile(fixture.pidFile, "utf8")
          .then(Number)
          .catch(() => undefined);

        if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* Already terminated by the tested owner. */
          }
        }
        await rm(fixture.directory, { recursive: true, force: true });
      }),
  );

/** Positive PID plus the final argv line prove the fixture body finished reporting startup. */
const started = Effect.fnUntraced(function* (
  fixture: Effect.Success<ReturnType<typeof stalledProcess>>,
) {
  const deadline = performance.now() + 2000;

  while (performance.now() < deadline) {
    const [pidText, args] = yield* Effect.promise(() =>
      Promise.all(
        [fixture.pidFile, fixture.argsFile].map((file) =>
          readFile(file, "utf8").catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          }),
        ),
      ),
    );

    const pid = Number(pidText);

    if (Number.isSafeInteger(pid) && pid > 0 && args?.endsWith("about:blank\n"))
      return { pid, args };
    yield* Effect.sleep(10);
  }

  return assert.fail(
    "The fixture did not report a positive PID and complete argv before connection",
  );
});

it.live("local startup timeout and interrupted connect terminate the exact launched process", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const interrupt of [false, true]) {
        const fixture = yield* stalledProcess();
        const reports: LocalCleanupResult[] = [];

        yield* Effect.scoped(
          Effect.gen(function* () {
            const acquired = yield* (yield* LocalBrowser).acquire(BrowserPolicy.unrestricted());
            const { pid } = yield* started(fixture);

            if (interrupt) {
              const connection = yield* acquired.connect.pipe(Effect.forkChild);

              yield* Effect.yieldNow;
              yield* Fiber.interrupt(connection);
            } else {
              const result = yield* acquired.connect.pipe(Effect.result);

              expect(result._tag).toBe("Failure");
              if (result._tag === "Failure")
                expect(result.failure).toMatchObject({
                  _tag: "BrowserError",
                  operation: "connect",
                  reason: "timeout",
                  outcome: "undispatched",
                });
            }
            const cleanup = yield* acquired.close;

            expect(cleanup.process).toBe("terminated");
            expect(cleanup.connection).toBe("not-connected");
            expect(cleanup.issues).toEqual([]);
            expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
            expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
          }),
        ).pipe(
          Effect.provide(
            LocalBrowser.layer({
              launch: {
                executablePath: fixture.executable,
                startupTimeoutMillis: interrupt ? 30000 : 100,
              },
              onCleanup: (result) =>
                Effect.sync(() => {
                  reports.push(result);
                }),
            }),
          ),
        );
        expect(reports).toHaveLength(1);
        expect(reports[0]!.process).toBe("terminated");
      }
    }),
  ),
);

it.live(
  "failed local spawn exposes a classified failure without inventing a session or leaking its path",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* (yield* LocalBrowser)
          .open(BrowserPolicy.unrestricted())
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("BrowserError");
          expect(result.failure.operation).toBe("launch");
          expect(JSON.stringify(result.failure)).not.toContain("PRIVATE-EXECUTABLE");
        }
      }),
    ).pipe(
      Effect.provide(
        LocalBrowser.layer({ launch: { executablePath: "/PRIVATE-EXECUTABLE/missing" } }),
      ),
    ),
);

it.live(
  "mutating caller launch options after layer build cannot replace the fixed sandbox, profile or proxy choices",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* stalledProcess();
        const args = ["--disable-quic"];
        const proxy = { server: "http://127.0.0.1:8080" };

        const context = yield* Layer.build(
          LocalBrowser.layer({
            launch: { executablePath: fixture.executable, startupTimeoutMillis: 100, args, proxy },
          }),
        );

        args[0] = "--no-sandbox";
        args.push("--user-data-dir=/unowned-profile");
        proxy.server = "http://127.0.0.1:9090";
        yield* Effect.gen(function* () {
          const acquired = yield* (yield* LocalBrowser).acquire(BrowserPolicy.unrestricted());
          const { pid, args: actual } = yield* started(fixture);

          expect(actual).toContain("--disable-quic\n");
          expect(actual).toContain("--proxy-server=http://127.0.0.1:8080\n");
          expect(actual).not.toContain("--no-sandbox");
          expect(actual).not.toContain("/unowned-profile");
          expect(actual).not.toContain(":9090");

          const profileArgument = actual
            .split("\n")
            .find((arg) => arg.startsWith("--user-data-dir="));

          assert.ok(profileArgument);
          const profile = profileArgument.slice("--user-data-dir=".length);

          expect((yield* Effect.promise(() => stat(profile))).isDirectory()).toBe(true);
          const result = yield* acquired.connect.pipe(Effect.result);

          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toMatchObject({
              _tag: "BrowserError",
              operation: "connect",
              reason: "timeout",
              outcome: "undispatched",
            });
          const cleanup = yield* acquired.close;

          expect(cleanup.connection).toBe("not-connected");
          expect(cleanup.process).toBe("terminated");
          expect(cleanup.issues).toEqual([]);
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
          expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
          yield* Effect.promise(() =>
            expect(stat(profile)).rejects.toMatchObject({ code: "ENOENT" }),
          );
        }).pipe(Effect.provide(context));
      }),
    ),
);

it.live(
  "an incomplete DevToolsActivePort is startup in progress; a complete non-loopback one is malformed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const [portFile, reason] of [
          ["", "timeout"],
          ["\n", "timeout"],
          ["12345\n/elsewhere/browser/x\n", "malformed"],
        ] as const) {
          const fixture = yield* stalledProcess(portFile);

          yield* Effect.scoped(
            Effect.gen(function* () {
              const acquired = yield* (yield* LocalBrowser).acquire(BrowserPolicy.unrestricted());

              yield* started(fixture);
              const result = yield* acquired.connect.pipe(Effect.result);

              expect(result._tag).toBe("Failure");
              if (result._tag === "Failure")
                expect(result.failure).toMatchObject({
                  _tag: "BrowserError",
                  operation: "connect",
                  reason,
                  outcome: "undispatched",
                });
              const cleanup = yield* acquired.close;

              expect(cleanup.process).toBe("terminated");
              expect(cleanup.connection).toBe("not-connected");
            }),
          ).pipe(
            Effect.provide(
              LocalBrowser.layer({
                launch: { executablePath: fixture.executable, startupTimeoutMillis: 300 },
              }),
            ),
          );
        }
      }),
    ),
);
