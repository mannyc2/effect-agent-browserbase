import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";

import { driftMarkup, driftSite, operators } from "./fixtures/DriftSite.ts";

it("drift changes matching, layout and structure without changing the intended destinations", () => {
  const baseline = driftMarkup("none", 1, "base");

  expect(baseline.match(/data-page="markets"/g)).toHaveLength(1);
  expect(driftMarkup("duplicate", 1, "duplicate").match(/>Markets<\/a>/g)).toHaveLength(2);
  expect(driftMarkup("rename", 1, "rename")).toContain('data-page="markets">Market data');
  expect(driftMarkup("offscreen", 1, "offscreen")).toContain('<div id="spacer"></div><nav>');
  expect(driftMarkup("overlay", 1, "overlay")).toContain('<section id="overlay">');
  expect(driftMarkup("shift", 1, "shift")).toContain('<div id="banner">');
  expect(driftMarkup("duplicate", 1, "duplicate")).toContain('data-page="decoy"');
  expect(driftMarkup("variant", 1, "variant")).toContain('class="variant"');
  expect(driftMarkup("reorder", 2, "reorder")).toContain('"items":["Gamma","Beta","Alpha"]');
  const seeded = [1, 2, 3, 4, 5].map((seed) => driftMarkup("reorder", seed, "seeded"));

  expect(new Set(seeded.map((markup) => markup.match(/"items":(\[[^\]]+\])/u)?.[1])).size).toBe(5);
  for (const markup of seeded) expect(markup).not.toContain('"items":["Alpha","Beta","Gamma"]');
  for (const operator of operators)
    expect(driftMarkup(operator, 1, "case")).toContain('href="/markets"');
});

it.live(
  "the fixture redirects at the server and stores truth independently of replay receipts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* driftSite;

        site.configure("redirect", 1, "redirect");

        const redirect = yield* Effect.promise(() =>
          fetch(`${site.url}/portal`, { redirect: "manual" }),
        );

        expect(redirect.status).toBe(301);
        expect(redirect.headers.get("location")).toBe("/new-portal");
        // fe6e26d let a cached permanent redirect bleed into subsequent drift cells.
        expect(redirect.headers.get("cache-control")).toBe("no-store");
        expect(site.truth("redirect")).toBeUndefined();
        const truth = { page: "article", tab: "Prices", item: "Beta", query: "" };

        const submitted = yield* Effect.promise(() =>
          fetch(`${site.url}/truth`, {
            method: "POST",
            body: JSON.stringify({ run: "redirect", truth }),
          }),
        );

        expect(submitted.status).toBe(204);
        expect(site.truth("redirect")).toEqual(truth);
        expect(site.lost()).toBe(0);

        const malformed = yield* Effect.promise(() =>
          fetch(`${site.url}/truth`, { method: "POST", body: "{" }),
        );

        expect(malformed.status).toBe(400);
      }),
    ),
);

it.live("a seeded slow visit delays its actual first HTML response", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* driftSite;

      site.configure("slow", 1, "slow");
      const started = yield* Clock.monotonicTimeNanos;
      const markup = yield* Effect.promise(async () => (await fetch(`${site.url}/portal`)).text());
      const elapsedMillis = Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;

      expect(elapsedMillis).toBeGreaterThanOrEqual(1000);
      expect(markup).toContain('data-page="markets">Markets');
      expect(site.events()).toHaveLength(0);
    }),
  ),
);
