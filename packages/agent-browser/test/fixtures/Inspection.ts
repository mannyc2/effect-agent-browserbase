import assert from "node:assert/strict";

import { Schema } from "effect";
import { Observation, ObservedElement } from "effect-browser/browser-data";
import type { LanguageModel } from "effect/unstable/ai";

/** Scripted model turns consume the actual prior inspection, never a guessed reference ID. */
export const inspectionReference = (request: LanguageModel.ProviderOptions, label: string) => {
  const result = request.prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result")
    .findLast((part) => part.name === "browser_inspect" && !part.isFailure);

  assert.ok(result, "The prior inspection must be present in the model request");
  const observation = Schema.decodeUnknownSync(Observation)(result.result);
  const matches = observation.controls.filter((control) => control.label === label);

  assert.equal(matches.length, 1, `Expected exactly one observed ${label}`);
  const control = matches[0];

  assert.ok(control);

  return ObservedElement.make({
    observationId: observation.observationId,
    elementId: control.elementId,
  });
};
