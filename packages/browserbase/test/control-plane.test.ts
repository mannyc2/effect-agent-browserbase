import { it } from "@effect/vitest";

import { controlPlaneCases } from "./fixtures/ControlPlaneCases.ts";

for (const test of controlPlaneCases) it.effect(test.name, () => test.run);
