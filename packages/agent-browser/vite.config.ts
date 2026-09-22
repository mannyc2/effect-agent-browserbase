import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      test: {
        command: "vp test --run --passWithNoTests && vp run test:native",
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
    entry: ["src/index.ts", "src/Adapter.ts", "src/Tools.ts"],
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
