import { markdown } from "@foldkit/markdown/vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss(), foldkit(), markdown()],
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
    server: { deps: { inline: ["effect-browser"] } },
  },
});
