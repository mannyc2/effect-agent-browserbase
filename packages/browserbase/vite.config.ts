import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      test: {
        command: "vp test --run && vp run test:native",
        input: [
          { auto: true },
          { pattern: "bun.lock", base: "workspace" },
          { pattern: "!**/node_modules", base: "workspace" },
          { pattern: "!**/node_modules/.vite*", base: "workspace" },
          { pattern: "!**/node_modules/.vite*/**", base: "workspace" },
        ],
        output: [],
      },
    },
  },
  pack: {
    entry: [
      "src/index.ts",
      "src/Bootstrap.ts",
      "src/Browser.ts",
      "src/BrowserData.ts",
      "src/Capture.ts",
      "src/Cleanup.ts",
      "src/Client.ts",
      "src/ContextCoordination.ts",
      "src/Contexts.ts",
      "src/Downloads.ts",
      "src/Errors.ts",
      "src/Extensions.ts",
      "src/Launch.ts",
      "src/PageControl.ts",
      "src/Recordings.ts",
      "src/References.ts",
      "src/Replays.ts",
      "src/SessionData.ts",
      "src/Sessions.ts",
      "src/Transfers.ts",
      "src/Uploads.ts",
    ],
    dts: true,
    sourcemap: true,
  },
  test: { include: ["test/*.test.ts"], cache: false, silent: "passed-only" },
});
