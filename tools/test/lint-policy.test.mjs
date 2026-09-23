import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const strictCompilerOptions = {
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
};
// Compiler options apply to a whole program. effect-agent-browser's program compiles upstream's
// effect-agent source, which is not written for noUncheckedIndexedAccess, so there the flag
// would report upstream code rather than ours.
const ownedProjects = {
  "packages/browser/tsconfig.json": { noUncheckedIndexedAccess: true },
  "packages/browserbase/tsconfig.json": { noUncheckedIndexedAccess: true },
  "packages/agent-browser/tsconfig.json": { noUncheckedIndexedAccess: undefined },
  "test/tsconfig.json": { noUncheckedIndexedAccess: true },
};

test("every owned TypeScript project opts into the same strict compiler checks", () => {
  for (const [path, specific] of Object.entries(ownedProjects)) {
    const options = JSON.parse(read(path)).compilerOptions;
    for (const [name, value] of Object.entries({ ...strictCompilerOptions, ...specific }))
      assert.equal(options[name], value, `${path} sets ${name}`);
  }
});

test("the strict lint policy reaches upstream's root config, bootstrap and acceptance", () => {
  const patch = read("upstream.patch");
  assert.match(patch, /^\+import \{ ownedOverrides \} from "\.\/lint\/owned\.ts";$/m);
  assert.match(patch, /^\+ {6}\.\.\.ownedOverrides,$/m);
  // Effect's Oxlint rules exist only in the patched Oxlint binding and tsgolint.
  assert.match(patch, /^\+ {4}"patch:tsgo": "effect-tsgo patch --typescript --oxlint",$/m);
  assert.match(read("tools/bootstrap.sh"), /'packages\/agent-browser', 'test', 'lint'\n/);
  const acceptance = read("tools/run-acceptance.sh");
  assert.match(acceptance, /run format timeout \d+s \.\/node_modules\/\.bin\/vp fmt --check [^\n]* test lint\n/);
  assert.match(
    acceptance,
    /run lint timeout \d+s \.\/node_modules\/\.bin\/vp lint --type-aware --report-unused-disable-directives-severity=error [^\n]* test lint\n/,
  );
});

test("the Oxlint pin agrees with the contributor toolchain table", () => {
  const pinned = read("upstream.patch").match(/^\+ {4}"oxlint": "([^"]+)",$/m)?.[1];
  assert.match(pinned ?? "", /^\d+\.\d+\.\d+$/);
  const documented = read("CONTRIBUTING.md").split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[1] === "Effect tsgo / Oxlint");
  assert.equal(documented.length, 1);
  assert.equal(documented[0][2].split(" / ")[1], pinned);
});

test("the policy is owned-only, error-only, and relaxes only its own rules", async () => {
  const { ownedOverrides } = await import("../../lint/owned.ts");
  const ownedPath = /^(?:packages\/\{browser,browserbase,agent-browser\}\/|packages\/browserbase\/hosted\/|test\/integration\/|test\/vite\.config\.ts$)/;
  const severity = (setting) => (Array.isArray(setting) ? setting[0] : setting);
  const [strict, library, tests] = ownedOverrides;

  assert.equal(ownedOverrides.length, 3);
  for (const override of ownedOverrides)
    for (const glob of override.files) assert.match(glob, ownedPath, `${glob} is an owned path`);
  assert.ok(strict.plugins.includes("effecttsgo"));
  for (const override of [strict, library])
    for (const [rule, setting] of Object.entries(override.rules))
      assert.equal(severity(setting), "error", `${rule} is enforced, not advisory`);
  for (const [rule, setting] of Object.entries(tests.rules)) {
    assert.equal(setting, "off", `${rule} is only relaxed in tests`);
    assert.equal(severity(strict.rules[rule]), "error", `${rule} is relaxed from the strict set`);
  }
});

const ownedSources = execFileSync(
  "git",
  ["ls-files", "-z", "--", "packages/browser", "packages/browserbase", "packages/agent-browser", "test", "lint"],
  { cwd: root, encoding: "utf8" },
).split("\0").filter((path) => /\.[cm]?ts$/.test(path));

test("every lint or Effect suppression in owned code says why", () => {
  assert.ok(ownedSources.includes("lint/owned.ts"));
  for (const path of ownedSources) {
    const lines = read(path).split("\n");

    lines.forEach((line, index) => {
      const location = `${path}:${index + 1}`;
      const lint = /\/[/*]\s*(?:oxlint|eslint)-(?:disable|enable)[\w-]*\s*(.*)$/.exec(line);

      if (lint) assert.match(lint[1], /\s--\s+\S.{9,}/, `${location} gives its reason after --`);
      if (/^\s*\/\/\s*@effect-diagnostics/.test(line))
        assert.match(lines[index - 1] ?? "", /^\s*\/\/\s+\S/, `${location} follows the comment explaining it`);
    });
  }
});
