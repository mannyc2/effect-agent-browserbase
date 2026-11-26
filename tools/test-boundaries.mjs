// Adversarial imports run in a copy: the source tree and concurrent work stay untouched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(join(tmpdir(), "effect-browser-boundaries-"));
try {
  await mkdir(join(work, "tools"), { recursive: true });
  for (const name of [
    "tools/check-boundaries.mjs",
    "tools/testing",
    "tsconfig.base.json",
    "package.json",
  ])
    await cp(join(root, name), join(work, name), { recursive: true });
  for (const name of ["browser", "chromium", "browserbase", "yielded", "human-strokes"]) {
    await mkdir(join(work, "packages", name), { recursive: true });
    for (const part of ["package.json", "src", "test"])
      await cp(join(root, "packages", name, part), join(work, "packages", name, part), {
        recursive: true,
      });
  }
  await cp(
    join(root, "packages/browser/tsconfig.json"),
    join(work, "packages/browser/tsconfig.json"),
  );
  await symlink(join(root, "node_modules"), join(work, "node_modules"), "dir");
  await writeFile(join(work, "packages/browserbase/src/boundary-probe.mts"), "export {};\n");
  await writeFile(join(work, "packages/browserbase/test/boundary-probe.mts"), "export {};\n");
  await writeFile(
    join(work, "tools/testing/boundary-probe.mts"),
    'export * from "./cdp-proxy.ts";\nimport "oxlint";\nimport "effect-browser/Page";\n',
  );
  await writeFile(
    join(work, "packages/browser/test/boundary-allowed.mts"),
    [
      'import "node:fs";',
      'import "vite";',
      'import "oxlint";',
      'import "@effect/vitest";',
      'import "../src/internal/page/lane.ts";',
      'import "../src/presentation/Stage.ts";',
      'import "../../../tools/testing/cdp-proxy.ts";',
      'import "effect-browser/Page";',
      'export type BoundaryAllowed = typeof import("effect-browser/Page");',
      'void import(new URL("./generated.mjs", import.meta.url).href);',
    ].join("\n"),
  );
  await writeFile(join(work, "packages/browser/src/internal/boundary-root.ts"), "export {};\n");
  // Exercise a distinct conditional kernel entry even when production shares its portable root.
  const browserManifestFile = join(work, "packages/browser/package.json");
  const browserManifest = JSON.parse(await readFile(browserManifestFile, "utf8"));

  browserManifest.exports["."].workerd["@effect-browser/source"] =
    "./src/internal/boundary-entry.ts";
  await writeFile(browserManifestFile, JSON.stringify(browserManifest));
  await writeFile(
    join(work, "packages/browser/src/internal/boundary-entry.ts"),
    'export * from "../index.ts";\nexport * from "./boundary-root.ts";\n',
  );
  const fixtures = [
    [
      "shared helper private test reexport",
      "../tools/testing/boundary-probe.mts",
      'export * from "../../packages/browser/test/Page.test.ts";',
      /relative import leaves its package/,
    ],
    [
      "shared helper private source reexport",
      "../tools/testing/boundary-probe.mts",
      'export * from "../../packages/browser/src/Page.ts";',
      /relative import leaves its package/,
    ],
    [
      "shared helper unexported subpath reexport",
      "../tools/testing/boundary-probe.mts",
      'export * from "effect-browser/internal/page/lane";',
      /unexported package subpath/,
    ],
    [
      "shared helper private import type expression",
      "../tools/testing/boundary-probe.mts",
      'export type BoundaryProbe = typeof import("effect-browser/internal/page/lane");',
      /unexported package subpath/,
    ],
    [
      "test relative sibling test import",
      "browserbase/test/boundary-probe.mts",
      'import "../../browser/test/Page.test.ts";',
      /relative import leaves its package/,
    ],
    [
      "test relative sibling source import",
      "browserbase/test/boundary-probe.mts",
      'import "../../browser/src/Page.ts";',
      /relative import leaves its package/,
    ],
    [
      "test shared directory sibling escape",
      "browserbase/test/boundary-probe.mts",
      'import "../../../tools/testing/../../packages/browser/src/Page.ts";',
      /relative import leaves its package/,
    ],
    [
      "test shared directory parent escape",
      "browserbase/test/boundary-probe.mts",
      'import "../../../tools/testing/../check-boundaries.mjs";',
      /relative import leaves its package/,
    ],
    [
      "test unexported sibling subpath",
      "browserbase/test/boundary-probe.mts",
      'import "effect-browser/internal/page/lane";',
      /unexported package subpath/,
    ],
    [
      "test sibling import type expression",
      "browserbase/test/boundary-probe.mts",
      'export type BoundaryProbe = typeof import("effect-browser/internal/page/lane");',
      /unexported package subpath/,
    ],
    [
      "test relative sibling import type expression",
      "browserbase/test/boundary-probe.mts",
      'export type BoundaryProbe = typeof import("../../browser/src/Page.ts");',
      /relative import leaves its package/,
    ],
    [
      "undeclared test dependency",
      "browserbase/test/boundary-probe.mts",
      'import "boundary-undeclared";',
      /undeclared test dependency/,
    ],
    [
      "alternate module extension",
      "browserbase/src/boundary-probe.mts",
      'import "effect-browser/internal/page/lane";',
      /unexported package subpath/,
    ],
    [
      "side-effect private kernel",
      "browser/src/presentation/Stage.ts",
      'import "../internal/page/lane.ts";',
      /feature imports private kernel/,
    ],
    [
      "unpublished sibling",
      "browser/src/presentation/Stage.ts",
      'import type { Step as BoundaryProbe } from "../walk/internal/data.ts";',
      /feature imports unpublished module/,
    ],
    [
      "private kernel import type expression",
      "browser/src/presentation/Stage.ts",
      'export type BoundaryProbe = import("../internal/page/lane.ts").Lane;',
      /feature imports private kernel/,
    ],
    [
      "private sibling import type expression",
      "browserbase/src/Browserbase.ts",
      'export type BoundaryProbe = typeof import("effect-browser/internal/page/lane");',
      /unexported package subpath/,
    ],
    [
      "Workers root feature export",
      "browser/src/internal/boundary-entry.ts",
      'export * as BoundaryProbe from "../presentation/Stage.ts";',
      /kernel imports feature/,
    ],
    [
      "transitive Workers root feature export",
      "browser/src/internal/boundary-root.ts",
      'export * as BoundaryProbe from "../presentation/Stage.ts";',
      /kernel imports feature/,
    ],
    [
      "Workers kernel deletion typecheck",
      "browser/src/internal/boundary-entry.ts",
      'export const BoundaryProbe: never = "Workers root must be checked";',
      /TS2322/,
    ],
    [
      "unexported self subpath",
      "browser/src/presentation/Stage.ts",
      'import "effect-browser/src/internal/page/lane.ts";',
      /unexported package subpath/,
    ],
    [
      "computed dependency",
      "browser/src/presentation/Stage.ts",
      'void import("../walk/" + "Walk.ts");',
      /module dependency must be a string literal/,
    ],
    [
      "private browser import from browserbase",
      "browserbase/src/Browserbase.ts",
      'import "effect-browser/internal/page/lane";',
      /unexported package subpath/,
    ],
    [
      "relative cross-package import",
      "yielded/src/YieldedTools.ts",
      'import "../../browser/src/Page.ts";',
      /relative import leaves its package/,
    ],
    [
      "undeclared runtime dependency",
      "browserbase/src/Browserbase.ts",
      'import "@yielded/agent";',
      /undeclared runtime dependency/,
    ],
    [
      "forbidden kernel dependency",
      "browser/package.json",
      (clean) =>
        JSON.stringify({
          ...JSON.parse(clean),
          dependencies: { "@yielded/agent": "0.1.0-beta.191" },
        }),
      /forbidden runtime dependency/,
    ],
    [
      "Yielded Agent outside its binding",
      "browserbase/package.json",
      (clean) =>
        JSON.stringify({
          ...JSON.parse(clean),
          devDependencies: { ...JSON.parse(clean).devDependencies, "@yielded/agent": "0.1.0-beta.191" },
        }),
      /only @effect-browser\/yielded depends on @yielded\/agent/,
    ],
    [
      "root runtime dependency",
      "browser/src/Action.ts",
      'import "playwright-core";',
      /the root loads playwright-core at runtime/,
    ],
    [
      "feature imports another feature's internal",
      "browser/src/policy/Policy.ts",
      'import "../timeline/internal/words.ts";',
      /feature imports unpublished module/,
    ],
    [
      "feature reaches a deleted feature outside the import graph",
      "browser/src/policy/Policy.ts",
      '/// <reference path="../presentation/Stage.ts" />',
      /With presentation deleted/,
    ],
    [
      "Node builtin in kernel",
      "browser/src/Action.ts",
      'import "node:fs";',
      /Node builtin in effect-browser/,
    ],
  ];
  const allowed = spawnSync(process.execPath, [join(work, "tools/check-boundaries.mjs")], {
    encoding: "utf8",
  });

  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  for (const [name, file, added, message] of fixtures) {
    const target = join(work, "packages", file);
    const clean = await readFile(target, "utf8");
    try {
      await writeFile(target, typeof added === "function" ? added(clean) : `${added}\n${clean}`);
      const result = spawnSync(process.execPath, [join(work, "tools/check-boundaries.mjs")], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${name} escaped the dependency check`);
      assert.match(result.stdout + result.stderr, message, `${name} failed for another reason`);
    } finally {
      await writeFile(target, clean);
    }
  }
  console.log(`Rejected ${fixtures.length} adversarial dependency fixtures.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
