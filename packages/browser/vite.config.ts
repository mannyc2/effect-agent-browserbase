import { defineConfig } from "vite-plus";

import { pageScript } from "./page-script.ts";
import { playwrightJpeg } from "./playwright-jpeg.ts";

export default defineConfig({
  resolve: { conditions: ["@effect-browser/source"] },
  pack: {
    plugins: [pageScript(), playwrightJpeg()],
    entry: ["src/*.ts", "src/workerd/*.ts"],
    dts: true,
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
