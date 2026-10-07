// The real command line, interrupted the way an operator does it; scripted and free.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

const bench = fileURLToPath(new URL("..", import.meta.url));

const exited = (child: ChildProcess) =>
  Effect.callback<number | null>((resume) => {
    child.once("exit", (code) => resume(Effect.succeed(code)));
  });

describe("an interrupted bench run", () => {
  it.live(
    "records every scheduled trial and the ledger, and leaves no browser files behind",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "bench-interrupt-"))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );

        const out = join(root, "out");
        // The run's own temporary directory, where Playwright keeps each browser's profile.
        const temporary = join(root, "tmp");

        mkdirSync(temporary);

        const child = spawn(
          process.execPath,
          [
            "--conditions=@effect-browser/source",
            "bench.ts",
            "run",
            "--task",
            "tumble-win",
            "--trials",
            "4",
            "--concurrency",
            "1",
            "--out",
            out,
          ],
          {
            cwd: bench,
            env: { ...process.env, TMPDIR: temporary },
            stdio: ["ignore", "pipe", "ignore"],
          },
        );

        const code = exited(child);

        // Interrupt once trials are scheduled, while the first tumble is still being captured.
        yield* Effect.callback<void>((resume) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("Running 4 trials")) resume(Effect.void);
          });
        });
        yield* Effect.sleep("2 seconds");
        child.kill("SIGINT");
        // The run's own interruption, as `runMain` reports one.
        assert.strictEqual(yield* code, 130);
        // The interruption closed the browser with its trial, which removes its profile.
        assert.deepStrictEqual(readdirSync(temporary), []);

        const files = readdirSync(out);
        const results = files.find((name) => name.endsWith("-scripted.jsonl"));
        const ledger = files.find((name) => name.endsWith("-scripted.ledger.json"));

        assert.isDefined(results);
        assert.isDefined(ledger);
        if (results === undefined || ledger === undefined) return;

        const records = readFileSync(join(out, results), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { status: string; reason: string; trial: number });

        assert.deepStrictEqual(
          records.map((record) => record.trial).toSorted((left, right) => left - right),
          [1, 2, 3, 4],
        );
        assert.isTrue(
          records.some((record) => record.status === "unrun" && record.reason === "interrupted"),
        );
        assert.deepInclude(JSON.parse(readFileSync(join(out, ledger), "utf8")), {
          interrupted: true,
          knownUsd: 0,
          reservedUsd: 0,
        });
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
});
