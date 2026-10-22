/** Explicit local latency run; ordinary ready includes only *.test.ts behavioral suites. */
import { defineConfig } from "vite-plus";

import base from "./vite.config.ts";

export default defineConfig({
  ...base,
  test: { ...base.test, include: ["test/**/*.latency.ts"], fileParallelism: false },
});
