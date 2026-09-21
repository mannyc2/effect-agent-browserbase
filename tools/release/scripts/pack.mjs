import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run only after the frozen install and release tests in the read-only build job.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2]);
const stage = await mkdtemp(join(tmpdir(), "browserbase-release-tooling-"));
try {
  await mkdir(join(stage, "tools/release"), { recursive: true });
  await cp(join(root, "tools/release/dist/tools"), join(stage, "tools"), { recursive: true });
  for (const name of ["package.json", "bun.lock", "node_modules"]) {
    await cp(join(root, "tools/release", name), join(stage, "tools/release", name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  await mkdir(output, { recursive: true });
  const archive = join(output, "release-tooling.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, "tools"], { timeout: 60_000 });
  // Test the archive consumers receive, including native CLI and relocated imports.
  const restored = join(stage, "restored");
  await mkdir(restored);
  execFileSync("tar", ["-xzf", archive, "-C", restored], { timeout: 60_000 });
  const application = join(restored, "tools/release");
  execFileSync("node", ["--input-type=module", "-e", 'await import("./src/application.js")'], {
    cwd: application,
    timeout: 30_000,
  });
  execFileSync("node", ["node_modules/.bin/ts-release", "--help"], {
    cwd: application,
    timeout: 30_000,
  });
  console.log(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
