import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("packed native suites include their complete local example dependency graph", () => {
  const destination = mkdtempSync(join(tmpdir(), "browserbase-example-staging-"));
  try {
    const script = readFileSync(join(root, "tools/packed-consumer.sh"), "utf8");
    const copies = script.split("\n").filter((line) => line.startsWith('  cp "$PKG'));
    assert.ok(copies.length > 0);
    execFileSync("bash", ["-eu", "-c", 'mkdir -p test/native test/fixtures examples\n' + copies.join("\n")], {
      cwd: destination,
      env: { ...process.env, PKG: join(root, "packages/platform-browserbase") },
    });
    const verify = () => {
      const seen = new Set();
      const check = (file) => {
        assert.ok(file.startsWith(destination + "/"), `Dependency escapes consumer: ${file}`);
        assert.ok(existsSync(file), `Missing staged dependency: ${file}`);
        if (seen.has(file)) return;
        seen.add(file);
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
          check(resolve(dirname(file), match[1]));
        }
      };
      for (const name of readdirSync(join(destination, "test/native"))) {
        if (name.endsWith(".test.ts")) check(join(destination, "test/native", name));
      }
      assert.ok(seen.has(join(destination, "examples/demo-recording.ts")));
      assert.ok(seen.has(join(destination, "examples/record-video.ts")));
    };
    verify();
    // Prove the original omission is detected without running a browser or a provider.
    rmSync(join(destination, "examples/demo-recording.ts"));
    assert.throws(verify, /Missing staged dependency: .*examples\/demo-recording\.ts/);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
