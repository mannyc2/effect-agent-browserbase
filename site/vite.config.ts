import { markdown } from "@foldkit/markdown/vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

import { localRunner } from "./demo/local.ts";
import { islandAttributes } from "./src/islands.ts";

export default defineConfig({
  plugins: [tailwindcss(), foldkit(), markdown({ islands: islandAttributes }), localRunner()],
  resolve: { conditions: ["@effect-browser/source"] },
  ssr: {
    resolve: {
      conditions: ["@effect-browser/source"],
      externalConditions: ["@effect-browser/source"],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["test/setup.ts"],
    server: { deps: { inline: ["effect-browser"] } },
  },
});
