// The repository lint rules that keep each package's sources importing their own modules by
// relative path, and that keep Effect's doc tags on every public export. Package names and exports
// maps come from the manifests, so a sibling's name is an ordinary import.
// It lives here because the bench is the workspace member without a declaration build.
import { fileURLToPath } from "node:url";

import { describe, it } from "@effect/vitest";
import { RuleTester } from "vite-plus/lint/plugins-dev";

import plugin from "../../lint/plugins/exports.ts";
import tags from "../../lint/plugins/tags.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const source = fileURLToPath(new URL("../../packages/browser/src/Probe.ts", import.meta.url));

const other = fileURLToPath(new URL("../../packages/human-strokes/src/Probe.ts", import.meta.url));

new RuleTester().run("no-self-barrel-import", plugin.rules["no-self-barrel-import"], {
  valid: [
    { code: 'import * as Motion from "./Motion.ts";', filename: source },
    { code: 'import * as Strokes from "@effect-browser/human-strokes";', filename: source },
    { code: 'import { Motion } from "effect-browser/presentation";', filename: other },
  ],
  invalid: [
    { code: 'import { Motion } from "effect-browser/presentation";', filename: source, errors: 1 },
    { code: 'import { Page } from "effect-browser";', filename: source, errors: 1 },
    { code: 'import * as Self from "@effect-browser/human-strokes";', filename: other, errors: 1 },
    { code: 'export * from "./index.ts";', filename: source, errors: 1 },
  ],
});

const internal = fileURLToPath(
  new URL("../../packages/browser/src/internal/Probe.ts", import.meta.url),
);

const unpublished = fileURLToPath(
  new URL("../../packages/tradingview/src/Probe.ts", import.meta.url),
);

const doc = (category?: string) =>
  `/**\n * @stability stable\n${category === undefined ? "" : ` * @category ${category}\n`} * @since 0.3.0\n */\n`;

const module = `${doc()}\n`;

new RuleTester().run("tags/public", tags.rules.public, {
  valid: [
    { code: `${module}${doc("models")}export interface Probe {}`, filename: source },
    { code: `${module}${doc()}export * as Probe from "./Probe.ts";`, filename: source },
    {
      code: `${module}export {\n${doc("guards")}isProbe,\n${doc("models")}type Probe } from "./internal/probe.ts";`,
      filename: source,
    },
    {
      code: `${module}${doc("constructors")}export function make(a: string): string;\nexport function make(a: number): number;\nexport function make(a: unknown) { return a; }`,
      filename: source,
    },
    { code: "export const probe = 1;", filename: internal },
    { code: "export const probe = 1;", filename: unpublished },
  ],
  invalid: [
    { code: "export const probe = 1;", filename: source, errors: 2 },
    { code: `${module}export const probe = 1;`, filename: source, errors: 1 },
    // The module's opening doc is not its first export's.
    { code: `${doc("constants")}export const probe = 1;`, filename: source, errors: 1 },
    { code: `${module}${doc()}export const probe = 1;`, filename: source, errors: 1 },
    { code: `${module}${doc("utilities")}export const probe = 1;`, filename: source, errors: 1 },
    { code: `${module}export * as Probe from "./Probe.ts";`, filename: source, errors: 1 },
    {
      code: `${module}export { a, ${doc("models")}b } from "./internal/probe.ts";`,
      filename: source,
      errors: 1,
    },
  ],
});
