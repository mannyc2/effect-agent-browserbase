import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["@effect-browser/source"] },
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run the workspace packages from source rather than from their unbuilt dist.
    server: { deps: { inline: ["effect-browser", "effect-browserbase"] } },
  },
});
