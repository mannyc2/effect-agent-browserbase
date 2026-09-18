import { it } from "@effect/vitest";
import { recoveryCases } from "./fixtures/RecoveryCases.ts";
import { runWithTestTime } from "./fixtures/TestTime.ts";

for (const test of recoveryCases) it.effect(test.name, () => runWithTestTime(test.run));
