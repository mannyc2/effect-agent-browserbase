import { it } from "@effect/vitest";

import { recoveryCases } from "./fixtures/RecoveryCases.ts";

for (const test of recoveryCases) it.effect(test.name, () => test.run);
