import { it } from "@effect/vitest";

import { providerOwnershipCases } from "./fixtures/ProviderOwnershipCases.ts";

for (const test of providerOwnershipCases) it.effect(test.name, () => test.run);
