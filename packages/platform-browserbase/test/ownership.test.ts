import { it } from "@effect/vitest";
import { ownershipCases } from "./fixtures/OwnershipCases.ts";
import { runWithTestTime } from "./fixtures/TestTime.ts";

for (const test of ownershipCases) it.effect(test.name, () => runWithTestTime(test.run));
