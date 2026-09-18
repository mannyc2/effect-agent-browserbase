import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      test: {
        command: "vp test",
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
      "src/InteractiveBrowser.ts",
      "src/Types.ts",
      "src/Tools.ts",
      "src/Recordings.ts",
      "src/Replays.ts",
      "src/Downloads.ts",
      "src/Capture.ts",
    ],
    dts: true,
    sourcemap: true,
  },
  test: { cache: false, silent: "passed-only" },
});
