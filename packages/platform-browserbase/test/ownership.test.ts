import { it } from "@effect/vitest";
import { ownershipCases } from "./fixtures/OwnershipCases.ts";

for (const test of ownershipCases) it.effect(test.name, () => test.run);
