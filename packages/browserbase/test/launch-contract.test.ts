import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  browserSettingsFields,
  contractSource,
  deliberatelyExcluded,
  sessionCreateFields,
} from "../src/internal/provider/Contract.ts";
import { compileLaunch } from "../src/internal/provider/Launch.ts";
import { LaunchRecipe, ProviderLaunchOptions } from "../src/Launch.ts";
import { ExtensionReference } from "../src/References.ts";

/** Fields the recipe owns itself rather than passing through as provider options. */
const recipeOwned = ["projectId", "timeout", "keepAlive", "extensionId"];
const settingsOwned = ["context", "viewport"];

const settings = Object.keys(ProviderLaunchOptions.fields.browserSettings.schema.fields);

it("the launch compiler accepts exactly the reviewed provider request subset", () => {
  expect(contractSource.version).toBe("2.20.0");
  // A field added or dropped here is a reviewed SDK change, not an incidental edit.
  expect([...Object.keys(ProviderLaunchOptions.fields), ...recipeOwned].sort()).toEqual(
    [...sessionCreateFields].sort(),
  );
  expect([...settings, ...settingsOwned].sort()).toEqual([...browserSettingsFields].sort());
});

it("durable extensions have one qualified spelling and aliases stay unreachable", () => {
  for (const excluded of deliberatelyExcluded) {
    const [group, field] = excluded.split(".");

    expect(group).toBe("browserSettings");
    expect(settings).not.toContain(field);
  }
  // The recipe owns extension selection outright: neither provider spelling is reachable,
  // so an unqualified identifier cannot be passed through unchecked.
  expect(Object.keys(LaunchRecipe.fields)).toContain("extension");
  expect(Object.keys(ProviderLaunchOptions.fields)).not.toContain("extensionId");
});

const identity = {
  projectId: "launch-project",
  attemptId: "11111111-2222-3333-4444-555555555555",
  requestedAtMillis: 0,
};

const extension = ExtensionReference.make({
  provider: "browserbase",
  projectId: identity.projectId,
  extensionId: "extension-1",
});

const recipe = (extra: Partial<LaunchRecipe> = {}): LaunchRecipe => ({
  remoteTimeoutSeconds: 60,
  viewport: { _tag: "ProviderManaged" },
  provider: {},
  ...extra,
});

it.effect("only a same-project reference becomes the provider's extensionId", () =>
  Effect.gen(function* () {
    const compiled = yield* compileLaunch(recipe({ extension }), identity);

    expect(compiled.body).toMatchObject({ extensionId: "extension-1" });

    const foreign = yield* compileLaunch(
      recipe({ extension: ExtensionReference.make({ ...extension, projectId: "other-project" }) }),
      identity,
    ).pipe(Effect.result);

    expect(foreign._tag).toBe("Failure");
    if (foreign._tag === "Failure") {
      expect(foreign.failure.reason).toBe("configuration");
      expect(foreign.failure.outcome).toBe("undispatched");
    }
  }),
);
