import type { OxfmtConfig } from "oxfmt";
import { defineConfig } from "vite-plus";

// Formatting follows Effect Agent's recommended Oxfmt defaults (danieljvdm/effect-agent@bcc2bb7,
// MIT; see LICENSE-effect-agent), which these packages were formatted with before they left
// its workspace. Lint policy is lint/.oxlintrc.json, which `bun run lint` applies.
const fmt = {
  arrowParens: "always",
  endOfLine: "lf",
  ignorePatterns: [".agents/**", ".claude/**", ".codex/**", ".work/**"],
  printWidth: 100,
  semi: true,
  singleQuote: false,
  sortImports: true,
  sortPackageJson: true,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
} satisfies OxfmtConfig;

export default defineConfig({
  fmt,
  pack: {
    dts: true,
    format: ["esm"],
    sourcemap: true,
  },
  test: {
    // Vite Task caches successful suites. Vitest's mutable results.json
    // otherwise becomes a task input and prevents reuse on fresh runners.
    cache: false,
    silent: "passed-only",
  },
});
