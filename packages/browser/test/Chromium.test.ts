// What a local launch passes to Chromium itself.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import * as Chromium from "../src/Chromium.ts";

/**
 * The command line of the browser that these options launch. Other files' browsers run beside it,
 * so it is found by a switch of its own, which Chromium ignores.
 */
const commandLine = (options: Chromium.Options) =>
  Effect.gen(function* () {
    const marker = `--effect-browser-test=${randomUUID()}`;

    yield* Chromium.open({ ...options, args: [marker] });

    // Every process, at full width, so no command line is cut short.
    const processes = yield* Effect.sync(() =>
      execFileSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" }),
    );

    const line = processes.split("\n").find((candidate) => candidate.includes(marker));

    assert.isDefined(line, "the launched browser's process");

    return line;
  }).pipe(Effect.scoped);

it.live("runs Chromium's sandbox when asked, or refuses to start without it", () =>
  Effect.gen(function* () {
    assert.include(yield* commandLine({}), "--no-sandbox");
    assert.include(yield* commandLine({ sandbox: false }), "--no-sandbox");

    // A host without unprivileged user namespaces, such as CI's runner, can't start the sandbox.
    // Asked for it, Chromium must then not start at all, and the error must say why.
    const asked = Result.match(yield* Effect.result(commandLine({ sandbox: true })), {
      onSuccess: (line) =>
        line.includes("--no-sandbox") ? `ran unsandboxed: ${line}` : "sandboxed",
      onFailure: (error) =>
        error.message.startsWith("launch failed: Chromium's sandbox could not start")
          ? "refused"
          : `failed otherwise: ${error.message}`,
    });

    assert.oneOf(asked, ["sandboxed", "refused"]);
  }),
);
