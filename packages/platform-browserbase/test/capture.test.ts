import { it } from "@effect/vitest";
import { captureCases } from "./fixtures/CaptureCases.ts";
import { runWithTestTime } from "./fixtures/TestTime.ts";

for (const test of captureCases) it.effect(test.name, () => runWithTestTime(test.run));
