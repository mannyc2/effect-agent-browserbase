import { it } from "@effect/vitest";
import { artifactCases } from "./fixtures/ArtifactCases.ts";
import { runWithTestTime } from "./fixtures/TestTime.ts";

for (const test of artifactCases) it.effect(test.name, () => runWithTestTime(test.run));
