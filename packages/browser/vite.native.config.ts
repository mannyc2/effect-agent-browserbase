import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/native/*.test.ts"],
    cache: false,
    maxWorkers: 1,
    testTimeout: 45000,
    hookTimeout: 45000,
    silent: "passed-only",
  },
});
