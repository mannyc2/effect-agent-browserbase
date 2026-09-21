import { it } from "@effect/vitest";

import { writerCases } from "./fixtures/WriterCases.ts";
for (const test of writerCases) it.effect(test.name, () => test.run);
