import { expect, it } from "@effect/vitest";

import {
  browserSettingsFields,
  contractSource,
  deliberatelyExcluded,
  sessionCreateFields,
} from "../src/internal/provider/Contract.ts";
import { ProviderLaunchOptions } from "../src/Launch.ts";

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
