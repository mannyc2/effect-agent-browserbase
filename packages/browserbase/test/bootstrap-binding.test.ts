import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Schema } from "effect";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const PublicSettings = Schema.Struct({
  label: Schema.String,
  revision: Schema.Int,
});

class ShowSettings extends Context.Service<
  ShowSettings,
  {
    readonly read: Effect.Effect<typeof PublicSettings.Type, "settings-unavailable">;
  }
>()("test/ShowSettings") {}

const settings = Bootstrap.binding({
  name: "getShowSettings",
  origins: ["https://portal.example.com"],
  input: Schema.Struct({ version: Schema.Literal(3) }),
  output: PublicSettings,
  maxConcurrent: 2,
  maxInputBytes: 256,
  maxOutputBytes: 4096,
  timeoutMillis: 3000,
  failureMode: "fail-session",
  handle: Effect.fn("test.getShowSettings")(function* () {
    return yield* (yield* ShowSettings).read;
  }),
});

const secondary = Bootstrap.binding({
  name: "secondary",
  origins: ["https://portal.example.com"],
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  maxConcurrent: 1,
  maxInputBytes: 128,
  maxOutputBytes: 128,
  timeoutMillis: 500,
  failureMode: "reject-call",
  handle: () => Effect.fail("secondary-failure" as const),
});

const combined = Bootstrap.combine(
  Bootstrap.init({ id: "marker", content: "globalThis.__marker = true;" }),
  settings,
  secondary,
);

const settingsError: Same<
  Bootstrap.PlanError<typeof settings>,
  "settings-unavailable"
> = true;
const settingsRequirements: Same<Bootstrap.PlanRequirements<typeof settings>, ShowSettings> = true;
const combinedError: Same<
  Bootstrap.PlanError<typeof combined>,
  "settings-unavailable" | "secondary-failure"
> = true;
const combinedRequirements: Same<
  Bootstrap.PlanRequirements<typeof combined>,
  ShowSettings
> = true;

it("keeps binding metadata bounded and preserves callback E/R through composition", () => {
  expect(settingsError && settingsRequirements && combinedError && combinedRequirements).toBe(true);
  expect(settings.bindings).toHaveLength(1);
  expect(settings.bindings?.[0]).toMatchObject({
    name: "getShowSettings",
    origins: ["https://portal.example.com"],
    maxConcurrent: 2,
    maxInputBytes: 256,
    maxOutputBytes: 4096,
    timeoutMillis: 3000,
    failureMode: "fail-session",
  });
  expect(typeof settings.bindings?.[0]?.handle).toBe("function");
  expect(combined.bindings?.map((registration) => registration.name)).toEqual([
    "getShowSettings",
    "secondary",
  ]);
});

it("keeps static-only plans serializable and refuses invalid binding admission bounds", () => {
  const staticPlan = Bootstrap.combine(
    Bootstrap.empty,
    Bootstrap.init({ id: "static", content: "globalThis.__static = true;" }),
  );

  expect(staticPlan.bindings).toBeUndefined();
  expect(Schema.decodeUnknownExit(Bootstrap.Plan)(staticPlan)._tag).toBe("Success");

  expect(() =>
    Bootstrap.binding({
      name: "invalid",
      origins: [],
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      maxConcurrent: 0,
      maxInputBytes: 128,
      maxOutputBytes: 128,
      timeoutMillis: 500,
      failureMode: "reject-call",
      handle: () => Effect.succeed("ok"),
    }),
  ).toThrow();
});
