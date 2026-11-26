import { defineConfig } from "vite-plus";

import { pageScript } from "./page-script.ts";
import { playwrightJpeg } from "./playwright-jpeg.ts";

export default defineConfig({
  plugins: [pageScript()],
  resolve: { conditions: ["@effect-browser/source"] },
  // The package's own subpaths, as an example imports them, from source rather than its dist.
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  pack: {
    plugins: [pageScript(), playwrightJpeg()],
    // Every public module is an entry, at its subpath; shared chunks go under the closed internal/.
    entry: [
      "src/*.ts",
      "src/{timeline,presentation,walk,policy,supervisor,testing}/*.ts",
      "src/internal/cdp/workerd.ts",
    ],
    outputOptions: { chunkFileNames: "internal/[name]-[hash].mjs" },
    dts: { tsconfig: "tsconfig.build.json" },
    sourcemap: true,
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One Chromium per file; files run in parallel.
    fileParallelism: true,
  },
});
