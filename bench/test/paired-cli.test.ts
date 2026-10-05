import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { environment } from "../Worker.ts";

const entry = fileURLToPath(new URL("../paired.ts", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));

const invoke = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.promise(
    () =>
      new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["--conditions=@effect-browser/source", entry, ...args],
            { cwd, env: environment(process.env), encoding: "utf8", timeout: 15_000 },
            (error, stdout, stderr) =>
              resolve({
                code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
                stdout,
                stderr,
              }),
          );
        },
      ),
  );

const directory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "paired-cli-"))),
  (value) => Effect.sync(() => rmSync(value, { recursive: true, force: true })),
);

describe("paired CLI resource boundary", () => {
  it.effect("can preview from outside the source checkout and records its source revision", () =>
    Effect.gen(function* () {
      const cwd = yield* directory;

      const result = yield* invoke(cwd, [
        "--provider",
        "local",
        "--local-trials",
        "1",
        "--tasks",
        "chart-read",
        "--arms",
        "5",
        "--out",
        join(cwd, "result"),
      ]);

      assert.strictEqual(result.code, 0);

      const saved = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ revision: Schema.String, mode: Schema.Literal("preview") }),
        ),
      )(readFileSync(join(cwd, "result", "manifest.json"), "utf8"));

      assert.match(saved.revision, /^[a-f0-9]{40}$/);
    }).pipe(Effect.scoped),
  );
  it.effect("refuses an unpaid model invocation before creating any output", () =>
    Effect.gen(function* () {
      const cwd = yield* directory;
      const target = join(cwd, "forbidden");

      const result = yield* invoke(cwd, [
        "--model",
        "openai/never-dispatch",
        "--provider",
        "local",
        "--out",
        target,
      ]);

      assert.strictEqual(result.code, 1);
      assert.include(result.stderr, '"code":"LiveRequired"');
      assert.isFalse(existsSync(target));
    }).pipe(Effect.scoped),
  );
  it.effect("does not mistake a dot-dot-prefixed child for an outside output directory", () =>
    Effect.gen(function* () {
      const cwd = yield* directory;
      const target = join(repository, "..results-" + randomUUID());
      const result = yield* invoke(cwd, ["--out", target]);

      assert.strictEqual(result.code, 1);
      assert.include(result.stderr, '"code":"Output"');
      assert.isFalse(existsSync(target));
    }).pipe(Effect.scoped),
  );
});
