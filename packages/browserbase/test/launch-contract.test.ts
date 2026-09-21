import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  browserSettingsFields,
  contractSource,
  deliberatelyExcluded,
  sessionCreateFields,
} from "../src/internal/provider/Contract.ts";
import { compileLaunch } from "../src/internal/provider/Launch.ts";
import type { LaunchRecipe } from "../src/Launch.ts";
import { ProviderLaunchOptions } from "../src/Launch.ts";
import { ExtensionReference } from "../src/References.ts";

/** Fields the recipe owns itself rather than passing through as provider options. */
const recipeOwned = ["projectId", "timeout", "keepAlive"];
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

it("deliberately excluded provider fields stay unreachable from a launch recipe", () => {
  for (const excluded of deliberatelyExcluded) {
    const [group, field] = excluded.split(".");

    expect(group).toBe("browserSettings");
    expect(settings).not.toContain(field);
  }
  // `extensionId` has exactly one top-level spelling, never a nested duplicate.
  expect(Object.keys(ProviderLaunchOptions.fields)).toContain("extensionId");
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

it.effect("a provisioned extension reference compiles to the one top-level selection", () =>
  Effect.gen(function* () {
    const compiled = yield* compileLaunch(recipe({ extension }), identity);

    expect(compiled.body).toMatchObject({ extensionId: "extension-1" });

    // The same identifier through both spellings is agreement, not a conflict.
    const agreed = yield* compileLaunch(
      recipe({ extension, provider: { extensionId: "extension-1" } }),
      identity,
    );

    expect(agreed.body).toMatchObject({ extensionId: "extension-1" });
  }),
);

it.effect("a foreign or conflicting extension selection is refused before allocation", () =>
  Effect.gen(function* () {
    const rejected = [
      recipe({ extension, provider: { extensionId: "extension-2" } }),
      recipe({
        extension: ExtensionReference.make({ ...extension, projectId: "other-project" }),
      }),
    ];

    for (const candidate of rejected) {
      const result = yield* compileLaunch(candidate, identity).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("configuration");
        expect(result.failure.outcome).toBe("undispatched");
      }
    }
  }),
);
