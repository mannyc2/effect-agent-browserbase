import { it } from "@effect/vitest";
import { artifactCases } from "./fixtures/ArtifactCases.ts";

for (const test of artifactCases) it.effect(test.name, () => test.run);
