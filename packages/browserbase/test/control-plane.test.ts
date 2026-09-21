import { it } from "@effect/vitest";
import type { Effect } from "effect";

import type { ClientError, ContextError, ExtensionError, SessionError } from "../src/Errors.ts";
import { controlPlaneCases } from "./fixtures/ControlPlaneCases.ts";

type ControlPlaneError = ClientError | ContextError | ExtensionError | SessionError;

for (const test of controlPlaneCases) {
  it.effect(test.name, (): Effect.Effect<void, ControlPlaneError> => test.run);
}
