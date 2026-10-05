import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["@effect-browser/source"] },
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  pack: { entry: ["src/index.ts"], dts: true, sourcemap: true },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: { deps: { inline: ["effect-browser"] } },
  },
});
