import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    cache: false,
    maxWorkers: 1,
    silent: "passed-only",
  },
});
