import { defineConfig } from "vite-plus";

import { pageScript } from "./page-script.ts";
import { playwrightJpeg } from "./playwright-jpeg.ts";

export default defineConfig({
  plugins: [pageScript()],
  resolve: { conditions: ["@effect-browser/source"] },
  pack: {
    plugins: [pageScript(), playwrightJpeg()],
    entry: [
      "src/*.ts",
      "src/workerd/Cdp.ts",
      "src/providers/{Chromium,Cdp,Released}.ts",
      "src/supervisor/Supervisor.ts",
      "src/presentation/*.ts",
      "src/moment/Moment.ts",
      "src/policy/Policy.ts",
      "src/stillness/Stillness.ts",
      "src/plan/index.ts",
      "src/testing/index.ts",
    ],
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
