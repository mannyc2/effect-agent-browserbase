import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

interface ProcessInfo {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly state: string;
}

const processes = async (): Promise<ProcessInfo[]> => {
  const { stdout } = await execute("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });

  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent, group, state] = line.trim().split(/\s+/);

      assert.ok(
        pid !== undefined && parent !== undefined && group !== undefined && state !== undefined,
      );

      return { pid: Number(pid), parent: Number(parent), group: Number(group), state };
    });
};

const signal = (pid: number, value: NodeJS.Signals) => {
  try {
    process.kill(pid, value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
};

/**
 * Observe an isolated POSIX host's descendants before killing it, retaining their groups across
 * reparenting. No Chromium flags, CDP transport, or library cleanup receipt enters this oracle.
 * The caller must spawn the host with detached:true so its group cannot include the test runner.
 */
export const processTree = (root: number) => {
  const members = new Set([root]);
  const groups = new Set([root]);

  const sample = async () => {
    const rows = await processes();
    const host = rows.find((row) => row.pid === root);

    assert.ok(host === undefined || host.group === root, "Host must own an isolated process group");
    let changed = true;

    while (changed) {
      changed = false;
      for (const row of rows) {
        if (members.has(row.parent) || groups.has(row.group) || members.has(row.pid)) {
          if (!members.has(row.pid) || !groups.has(row.group)) changed = true;
          members.add(row.pid);
          groups.add(row.group);
        }
      }
    }

    // Zombies have exited and hold no browser resources; an external init owns their reaping.
    return rows.filter((row) => members.has(row.pid) && !row.state.startsWith("Z"));
  };

  const waitForExit = async (timeoutMillis: number) => {
    const deadline = performance.now() + timeoutMillis;
    let remaining = await sample();

    while (remaining.length > 0 && performance.now() < deadline) {
      await delay(25);
      remaining = await sample();
    }

    return remaining;
  };

  return {
    sample,
    waitForExit,
    // Only call after recording the oracle, or when setup fails. Never mask the library's leak.
    cleanup: async () => {
      for (const value of ["SIGTERM", "SIGKILL"] as const) {
        const remaining = await sample();

        for (const group of new Set(remaining.map((row) => row.group))) signal(-group, value);
        for (const row of remaining) signal(row.pid, value);
        if ((await waitForExit(2000)).length === 0) return;
      }
      assert.deepEqual(await sample(), [], "Test-owned processes survived emergency cleanup");
    },
  };
};
