import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  CheckpointOptions,
  ControlFacts,
  Observation,
  ObservationOptions,
  ObservedControl,
  PointerMoveRequest,
  WheelRequest,
} from "effect-browserbase/browser-data";

const accepts = <A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown) =>
  Schema.decodeUnknownOption(schema)(value, { onExcessProperty: "error" })._tag === "Some";

it("reading options are bounded, closed, and leave their defaults to admission", () => {
  expect(accepts(ObservationOptions, {})).toBe(true);
  expect(accepts(ObservationOptions, { scope: "viewport", maxTextBytes: 1, maxControls: 0 })).toBe(
    true,
  );
  for (const invalid of [
    { scope: "screen" },
    { maxTextBytes: 0 },
    { maxTextBytes: 131073 },
    { maxControls: 65 },
    { maxControls: 1.5 },
    { picture: true },
  ])
    expect(accepts(ObservationOptions, invalid), JSON.stringify(invalid)).toBe(false);
  expect(accepts(CheckpointOptions, { picture: true, maxControls: 64 })).toBe(true);
  // A checkpoint always reads the viewport, so it has no scope to get wrong.
  expect(accepts(CheckpointOptions, { scope: "document" })).toBe(false);
});

it("pointer input is finite and lies in a viewport, never a document offset", () => {
  expect(accepts(PointerMoveRequest, { to: { x: 0, y: 16384 } })).toBe(true);
  for (const to of [
    { x: -1, y: 0 },
    { x: 0, y: 16385 },
    { x: Number.NaN, y: 0 },
  ])
    expect(accepts(PointerMoveRequest, { to }), JSON.stringify(to)).toBe(false);
  expect(accepts(WheelRequest, { deltaX: 0, deltaY: -100000 })).toBe(true);
  expect(accepts(WheelRequest, { deltaX: 0, deltaY: Number.POSITIVE_INFINITY })).toBe(false);
});

it("what a model is shown has no field that could carry a destination or a value", () => {
  const shown = new Set([
    ...Object.keys(Observation.fields),
    ...Object.keys(ObservedControl.fields),
  ]);

  // Every host-only fact, by name. Adding one to the model-facing schema must fail here.
  for (const hostOnly of Object.keys(ControlFacts.fields).filter(
    (field) => !["kind", "label", "disabled"].includes(field),
  ))
    expect(shown.has(hostOnly), hostOnly).toBe(false);
  expect([...shown]).not.toContain("value");
});
