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
      "src/CaptureEvidence.ts",
      "src/Chromium.ts",
      "src/Errors.ts",
      "src/PageControl.ts",
      "src/Recording.ts",
      "src/RecordingData.ts",
      "src/RecordingFfmpeg.ts",
      "src/Testing.ts",
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

            return undefined;
          },
        },
        // Keep ambient declaration helpers private without changing explicit exports.
        renderChunk: {
          order: "post",
          handler(code, chunk) {
            if (chunk.fileName.endsWith(".d.mts")) {
              return { code: code + "\nexport {};", map: null };
            }

            return undefined;
          },
        },
      },
    ],
    dts: true,
    sourcemap: true,
  },
  test: { include: ["test/*.test.ts"], cache: false, silent: "passed-only" },
});
