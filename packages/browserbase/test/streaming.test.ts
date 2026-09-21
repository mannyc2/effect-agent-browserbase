import { it } from "@effect/vitest";

import { streamingCases } from "./fixtures/StreamingCases.ts";
for (const test of streamingCases) it.effect(test.name, () => test.run);
