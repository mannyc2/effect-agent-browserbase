import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

// Keep the separate host in the fixture closure of installed-tarball acceptance too.
import type {} from "../fixtures/ChromiumHost.ts";
import { processTree } from "../fixtures/ProcessTree.ts";

const hostPath = fileURLToPath(new URL("../fixtures/ChromiumHost.ts", import.meta.url));

// Requested regression seam: kill the real host before connection and with a live session.
// SIGKILL cannot run finalizers. Both supported host runtimes need this proof; a successful
// scope-close control also verifies that the process observer can distinguish cleanup from leaks.
describe.each(["node", "bun"])("%s Chromium host lifetime", (runtime) => {
  describe.each([
    { phase: "connected", stop: "close", knownFailure: false },
    { phase: "acquired", stop: "SIGKILL", knownFailure: true },
    { phase: "connected", stop: "SIGKILL", knownFailure: true },
  ] as const)("$phase / $stop", ({ phase, stop, knownFailure }) => {
    let survivors: Awaited<ReturnType<ReturnType<typeof processTree>["sample"]>>;
    let cleanup: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const directory = await mkdtemp(join(tmpdir(), "chromium-host-death-"));

      const host = spawn(runtime, [hostPath, phase], {
        detached: true,
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let output = "";
      let diagnostic = "";
      let spawnError: Error | undefined;

      host.on("error", (error) => {
        spawnError = error;
      });
      host.stdin.on("error", (error) => {
        spawnError = error;
      });
      host.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
      });
      host.stderr.on("data", (chunk: Buffer) => {
        diagnostic = (diagnostic + chunk.toString()).slice(-8192);
      });

      const tree = host.pid === undefined ? undefined : processTree(host.pid);

      cleanup = async () => {
        try {
          await tree?.cleanup();
        } finally {
          host.stdin.destroy();
          host.stdout.destroy();
          host.stderr.destroy();
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      };

      assert.ok(tree, "Host did not spawn");
      const startup = performance.now() + 30000;

      while (!output.includes("ready\n")) {
        assert.equal(spawnError, undefined);
        assert.ok(
          host.exitCode === null && host.signalCode === null,
          `Host exited before ready: ${diagnostic}`,
        );
        assert.ok(performance.now() < startup, `Host never became ready: ${diagnostic}`);
        await tree.sample();
        await delay(25);
      }
      const started = await tree.sample();

      assert.ok(
        started.some((row) => row.pid !== host.pid),
        "No live browser descendant was observed",
      );
      // Only the host receives a signal. Killing its whole group/tree would hide the defect.
      if (stop === "SIGKILL") assert.ok(host.kill(stop));
      else host.stdin.end(`${stop}\n`);

      const exited = performance.now() + 10000;

      while (host.exitCode === null && host.signalCode === null) {
        assert.equal(spawnError, undefined);
        assert.ok(performance.now() < exited, `Host did not exit: ${diagnostic}`);
        await tree.sample();
        await delay(25);
      }
      assert.equal(host.signalCode, stop === "SIGKILL" ? stop : null);
      assert.equal(host.exitCode, stop === "close" ? 0 : null);
      survivors = await tree.waitForExit(3000);
    });

    afterAll(async () => {
      await cleanup?.();
    });

    // The detached-port launcher currently fails this invariant on abrupt host death. Remove
    // knownFailure when the separate library fix lands: an unexpected pass fails this test.
    // Setup/exit checks and emergency cleanup live in SUITE hooks (beforeEach/afterEach failures
    // are inverted by `fails` too). Only the independently observed orphan list may fail here.
    it("leaves no live owned processes after host exit", { fails: knownFailure }, () => {
      expect(survivors).toEqual([]);
    });
  });
});
