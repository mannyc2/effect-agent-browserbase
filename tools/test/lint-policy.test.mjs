import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

// Oxlint reads its config as JSON with comments. Strings are kept whole, so a `//` inside one
// survives; every comment outside a string is dropped.
const parseJsonc = (source) =>
  JSON.parse(
    source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
      match.startsWith('"') ? match : "",
    ),
  );

const config = parseJsonc(read("lint/.oxlintrc.json"));
const severity = (setting) => (Array.isArray(setting) ? setting[0] : setting);
const pluginOf = (rule) => (rule.includes("/") ? rule.split("/")[0] : "eslint");

const strictCompilerOptions = {
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  // Oxlint reports Effect's diagnostics; the patched `tsc` only typechecks.
  plugins: [{ name: "@effect/language-service", diagnostics: false }],
};
// Compiler options apply to a whole program. effect-agent-browser's program compiles upstream's
// effect-agent source, which is not written for noUncheckedIndexedAccess, so there the flag
// would report upstream code rather than ours.
const ownedProjects = {
  "packages/browser/tsconfig.json": { noUncheckedIndexedAccess: true },
  "packages/browserbase/tsconfig.json": { noUncheckedIndexedAccess: true },
  "packages/agent-browser/tsconfig.json": { noUncheckedIndexedAccess: undefined },
};

test("every owned TypeScript project opts into the same strict compiler checks", () => {
  for (const [path, specific] of Object.entries(ownedProjects)) {
    const options = JSON.parse(read(path)).compilerOptions;
    for (const [name, value] of Object.entries({ ...strictCompilerOptions, ...specific }))
      assert.deepEqual(options[name], value, `${path} sets ${name}`);
  }
});

test("the lint config extends Effect's recommended preset and enables every rule's plugin", () => {
  assert.deepEqual(config.extends, ["../node_modules/@effect/tsgo/oxlint-presets/recommended.json"]);
  assert.equal(config.options.typeAware, true);
  // Oxlint drops a rule whose plugin is not enabled, without saying so.
  const enabled = new Set(["eslint", ...config.plugins, ...config.jsPlugins.map(({ name }) => name)]);

  for (const rules of [config.rules, ...config.overrides.map((override) => override.rules)])
    for (const rule of Object.keys(rules))
      assert.ok(enabled.has(pluginOf(rule)), `${rule} has its plugin enabled`);
  for (const [rule, setting] of Object.entries(config.rules))
    assert.ok(["error", "off"].includes(severity(setting)), `${rule} is enforced or off, not advisory`);
});

test("overrides reach only owned paths, and each one either tightens or relaxes", () => {
  // Globs resolve from the config's own directory, so an owned path is matched at any depth.
  const ownedPath =
    /^\*\*\/(?:packages\/(?:\*|browser|browserbase|agent-browser)\/|test\/integration\/)/;

  for (const override of config.overrides) {
    for (const glob of override.files) assert.match(glob, ownedPath, `${glob} is an owned path`);
    const severities = new Set(Object.values(override.rules).map(severity));

    assert.equal(severities.size, 1, `${override.files[0]} only tightens or only relaxes`);
    if (!severities.has("off")) continue;
    // Relaxing is only for a rule that is on: one of ours, or one of Effect's preset.
    for (const rule of Object.keys(override.rules))
      assert.ok(
        severity(config.rules[rule]) === "error" || rule.startsWith("effecttsgo/"),
        `${rule} is relaxed from an enforced rule`,
      );
  }
});

test("the lint config reaches bootstrap and acceptance, beside upstream's own", () => {
  const patch = read("upstream.patch");
  // Effect's Oxlint rules exist only in the patched Oxlint binding and tsgolint, and plain Oxlint
  // finds tsgolint only as a root dependency.
  assert.match(patch, /^\+ {4}"patch:tsgo": "effect-tsgo patch --typescript --oxlint",$/m);
  assert.match(patch, /^\+ {4}"oxlint-tsgolint": "\d+\.\d+\.\d+",$/m);
  // Upstream's root config lints upstream; nothing here reaches into it.
  assert.doesNotMatch(patch, /^diff --git a\/vite\.config\.ts /m);
  assert.match(read("tools/bootstrap.sh"), /'packages\/agent-browser', 'test', 'lint'\n/);
  const acceptance = read("tools/run-acceptance.sh");
  assert.match(acceptance, /run format timeout \d+s \.\/node_modules\/\.bin\/vp fmt --check [^\n]* test lint\n/);
  assert.match(
    acceptance,
    /run lint timeout \d+s \.\/node_modules\/\.bin\/oxlint -c lint\/\.oxlintrc\.json --deny-warnings --report-unused-disable-directives-severity=error packages\/browser packages\/browserbase packages\/agent-browser test\/integration test\/vite\.config\.ts\n/,
  );
});

test("the Oxlint and tsgolint pins agree with the contributor toolchain table", () => {
  const patch = read("upstream.patch");
  const pinned = (name) => patch.match(new RegExp(`^\\+ {4}"${name}": "([^"]+)",$`, "m"))?.[1];
  const documented = (tool) =>
    read("CONTRIBUTING.md")
      .split("\n")
      .map((line) => line.split("|").map((cell) => cell.trim()))
      .filter((cells) => cells[1] === tool)
      .map((cells) => cells[2]);

  assert.match(pinned("oxlint") ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(documented("Effect tsgo / Oxlint")[0]?.split(" / ")[1], pinned("oxlint"));
  assert.deepEqual(documented("oxlint-tsgolint"), [pinned("oxlint-tsgolint")]);
});

const ownedSources = execFileSync(
  "git",
  ["ls-files", "-z", "--", "packages/browser", "packages/browserbase", "packages/agent-browser"],
  { cwd: root, encoding: "utf8" },
).split("\0").filter((path) => /\.[cm]?ts$/.test(path));

test("every lint or Effect suppression in owned code says why", () => {
  assert.ok(ownedSources.length > 0);
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
