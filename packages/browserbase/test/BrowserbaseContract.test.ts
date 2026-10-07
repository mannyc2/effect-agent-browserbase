// The in-memory API keeps every promise the contract checks, as Browserbase must.
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";

import * as BrowserbaseContract from "../src/testing/BrowserbaseContract.ts";
import * as TestBrowserbase from "../src/testing/TestBrowserbase.ts";

// Checks that wait for Browserbase run on the real clock; those that move it, on the test clock.
describe("BrowserbaseContract", () => {
  for (const check of BrowserbaseContract.checks.filter(({ clock }) => !clock))
    it.live(check.name, () => check.run.pipe(Effect.provide(TestBrowserbase.layer())));
  for (const check of BrowserbaseContract.checks.filter(({ clock }) => clock))
    it.effect(check.name, () => check.run.pipe(Effect.provide(TestBrowserbase.layer())));
});
