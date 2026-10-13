/** Ship Playwright's exact JPEG decoder without its unrelated Node utility bundle. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { TsdownPlugin } from "vite-plus/pack";

const require = createRequire(import.meta.url);
const bundle = require.resolve("playwright-core/lib/utilsBundle");
const virtual = "virtual:effect-browser/playwright-jpeg";

/** Fail an upstream bundle change rather than quietly shipping another decoder. */
const section = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);

  if (start < 0 || end < 0) throw new Error(`Playwright's bundled JPEG section changed: ${from}`);

  return source.slice(start, end);
};

export const playwrightJpeg = (): TsdownPlugin => {
  const source = readFileSync(bundle, "utf8");

  const decoder = section(
    source,
    "// node_modules/jpeg-js/lib/decoder.js\n",
    "// node_modules/jpeg-js/index.js\n",
  );

  // Keep the upstream CommonJS factory untouched, with its own bundled helper.
  const common = section(source, "var __commonJS = ", "var __export = ");

  const license = section(
    readFileSync(`${bundle}.LICENSE`, "utf8"),
    "%% jpeg-js@0.4.4 NOTICES AND INFORMATION BEGIN HERE",
    "END OF jpeg-js@0.4.4 NOTICES AND INFORMATION",
  );

  return {
    name: "playwright-jpeg",
    transform(code, id) {
      if (!id.endsWith("/internal/pictures/motion.ts")) return undefined;
      const imported = 'from "playwright-core/lib/utilsBundle"';

      if (!code.includes(imported)) throw new Error("The JPEG decoder import changed.");

      return {
        code: code.replace(imported, `from "${virtual}"`),
        // Only this import's columns move; preserve the original line locations.
        map: {
          version: 3,
          sources: [id],
          sourcesContent: [code],
          names: [],
          mappings: code
            .split("\n")
            .map((_, line) => (line === 0 ? "AAAA" : "AACA"))
            .join(";"),
        },
      };
    },
    resolveId(id) {
      return id === virtual ? `\0${virtual}` : undefined;
    },
    load(id) {
      return id === `\0${virtual}`
        ? `var __getOwnPropNames = Object.getOwnPropertyNames;\n${common}\n${decoder}\nexport const jpegjs = { decode: require_decoder() };`
        : undefined;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE-jpeg-js", source: license });
    },
  };
};
