import { it } from "@effect/vitest";
import { acquisitionCases } from "./fixtures/AcquisitionCases.ts";
for (const test of acquisitionCases) it.effect(test.name, () => test.run);
