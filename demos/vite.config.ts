import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Served from any path, such as a static host's subdirectory.
  base: "./",
  plugins: [react()],
  resolve: { conditions: ["@effect-browser/source"] },
  // Tests run in Vite's SSR environment, before the workspace packages are built.
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: ["effect-browser"] } },
  },
});
