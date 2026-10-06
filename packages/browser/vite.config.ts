import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["@effect-browser/source"] },
  pack: {
    entry: ["src/*.ts"],
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
