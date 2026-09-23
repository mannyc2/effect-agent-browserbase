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
      "src/Account.ts",
      "src/Agents.ts",
      "src/Allocation.ts",
      "src/Browser.ts",
      "src/BrowserBinding.ts",
      "src/Certificates.ts",
      "src/Cleanup.ts",
      "src/Client.ts",
      "src/ContextCoordination.ts",
      "src/Contexts.ts",
      "src/Downloads.ts",
      "src/Errors.ts",
      "src/Extensions.ts",
      "src/Functions.ts",
      "src/Launch.ts",
      "src/PageFetch.ts",
      "src/Projects.ts",
      "src/Recordings.ts",
      "src/References.ts",
      "src/Replays.ts",
      "src/Search.ts",
      "src/SessionData.ts",
      "src/Sessions.ts",
      "src/Transfers.ts",
      "src/Uploads.ts",
      "src/Webhooks.ts",
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
          },
        },
        // Keep ambient declaration helpers private without changing explicit exports.
        renderChunk: {
          order: "post",
          handler(code, chunk) {
            if (chunk.fileName.endsWith(".d.mts")) {
              return { code: code + "\nexport {};", map: null };
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
