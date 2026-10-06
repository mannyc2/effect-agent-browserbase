// The repository lint rule that keeps each package's sources importing their own modules by
// relative path. Package names come from the manifests, so a sibling's name is an ordinary import.
// It lives here because the bench is the workspace member without a declaration build.
import { fileURLToPath } from "node:url";

import { describe, it } from "@effect/vitest";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import plugin from "../../lint/plugins/exports.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const source = fileURLToPath(new URL("../../packages/browser/src/Probe.ts", import.meta.url));

const other = fileURLToPath(new URL("../../packages/human-strokes/src/Probe.ts", import.meta.url));

new RuleTester().run("no-self-barrel-import", plugin.rules["no-self-barrel-import"], {
  valid: [
    { code: 'import * as Motion from "./Motion.ts";', filename: source },
    { code: 'import * as Strokes from "effect-browser-human-strokes";', filename: source },
    { code: 'import * as Motion from "effect-browser/Motion";', filename: other },
  ],
  invalid: [
    { code: 'import * as Motion from "effect-browser/Motion";', filename: source, errors: 1 },
    { code: 'import { Page } from "effect-browser";', filename: source, errors: 1 },
    { code: 'import * as Self from "effect-browser-human-strokes";', filename: other, errors: 1 },
    { code: 'export * from "./index.ts";', filename: source, errors: 1 },
  ],
});
