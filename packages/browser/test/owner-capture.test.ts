import { it } from "@effect/vitest";

import { captureCases } from "./fixtures/CaptureCases.ts";

for (const test of captureCases) it.effect(test.name, () => test.run);
