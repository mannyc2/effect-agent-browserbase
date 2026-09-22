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
      "src/BrowserRuntime.ts",
      "src/Capture.ts",
      "src/CaptureData.ts",
      "src/Chromium.ts",
      "src/Errors.ts",
      "src/PageControl.ts",
    ],
    // Keep root namespaces on the public entry modules; the pinned bundler otherwise
    // exposes synthetic namespace exports on those entries, even with strict signatures.
    plugins: [
      {
        name: "public-entry-namespaces",
        resolveId: {
          order: "pre",
          handler(id, importer) {
            if (id.startsWith("./") && /[/\\]src[/\\]index(?:\.d)?\.ts$/.test(importer ?? "")) {
              return { id: id.replace(/(?:\.d)?\.ts$/, ".mjs"), external: true };
            }
          },
        },
      },
    ],
    dts: true,
    sourcemap: true,
  },
  test: { include: ["test/*.test.ts"], cache: false, silent: "passed-only" },
});
