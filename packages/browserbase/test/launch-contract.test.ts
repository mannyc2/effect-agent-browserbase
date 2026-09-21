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
  expect([...Object.keys(ProviderLaunchOptions.fields), ...recipeOwned].sort()).toEqual(
    [...sessionCreateFields].sort(),
  );
  expect([...settings, ...settingsOwned].sort()).toEqual([...browserSettingsFields].sort());
});

it("durable extensions have one qualified recipe spelling and provider aliases stay unreachable", () => {
  expect(Object.keys(LaunchRecipe.fields)).toContain("extension");
  expect(Object.keys(ProviderLaunchOptions.fields)).not.toContain("extensionId");

  for (const excluded of deliberatelyExcluded) {
    const [group, field] = excluded.split(".");

    expect(group).toBe("browserSettings");
    expect(settings).not.toContain(field);
  }
});

it.effect("the compiler projects only a same-project ExtensionReference to provider extensionId", () =>
  Effect.gen(function* () {
    const base = {
      remoteTimeoutSeconds: 60,
      viewport: { _tag: "ProviderManaged" as const },
      provider: {},
    };
    const extension = ExtensionReference.make({
      provider: "browserbase",
      projectId: "project-1",
      extensionId: "extension-1",
    });
    const identity = {
      projectId: "project-1",
      attemptId: "attempt-1",
      requestedAtMillis: 1,
    };
    const compiled = yield* compileLaunch({ ...base, extension }, identity);

    expect(compiled.body).toMatchObject({ extensionId: "extension-1" });

    const foreign = yield* compileLaunch(
      {
        ...base,
        extension: ExtensionReference.make({ ...extension, projectId: "project-2" }),
      },
      identity,
    ).pipe(Effect.result);

    expect(foreign._tag).toBe("Failure");
    if (foreign._tag === "Failure") {
      expect(foreign.failure.reason).toBe("configuration");
      expect(foreign.failure.outcome).toBe("undispatched");
    }
  }),
);
