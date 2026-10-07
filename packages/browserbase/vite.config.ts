import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["@effect-browser/source"] },
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  pack: { entry: ["src/*.ts", "src/testing/index.ts"], dts: true, sourcemap: true },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run the workspace's effect-browser from source rather than from its unbuilt dist.
    server: { deps: { inline: ["effect-browser"] } },
  },
});
