import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: [
      "src/index.ts",
      "src/Client.ts",
      "src/References.ts",
      "src/Errors.ts",
      "src/Transfers.ts",
      "src/BrowserData.ts",
      "src/Cleanup.ts",
      "src/Launch.ts",
      "src/SessionData.ts",
      "src/Sessions.ts",
      "src/Contexts.ts",
      "src/ContextCoordination.ts",
    ],
    dts: true,
    sourcemap: true,
  },
  test: { include: ["test/*.test.ts"], cache: false, silent: "passed-only" },
});
