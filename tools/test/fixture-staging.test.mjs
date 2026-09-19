import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("packed native fixture staging includes every relative source dependency", () => {
  const destination = mkdtempSync(join(tmpdir(), "browserbase-fixture-staging-"));
  try {
    const script = readFileSync(join(root, "tools/packed-consumer.sh"), "utf8");
    const copies = script.split("\n").filter((line) => line.startsWith('  cp "$PKG/test/fixtures/'));
    assert.ok(copies.length > 0);
    execFileSync("bash", ["-eu", "-c", 'mkdir -p test/fixtures\n' + copies.join("\n")], {
      cwd: destination,
      env: { ...process.env, PKG: join(root, "packages/platform-browserbase") },
    });
    const seen = new Set();
    const check = (file) => {
      assert.ok(existsSync(file), `Missing staged fixture dependency: ${file}`);
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const dependency = resolve(dirname(file), match[1]);
        assert.ok(dependency.startsWith(join(destination, "test/fixtures") + "/"));
        check(dependency);
      }
    };
    check(join(destination, "test/fixtures/LocalBrowser.ts"));
    assert.ok(seen.size >= 3);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
