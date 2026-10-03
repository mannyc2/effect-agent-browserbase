import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { loadPanelReport, panelReport, preparePanel, servePanel, shuffled } from "./bench/Panel.ts";

it("panel shuffle and descriptive rater intervals retain real sample counts", () => {
  expect(shuffled([1, 2, 3, 4], 17)).toEqual(shuffled([1, 2, 3, 4], 17));
  expect([...shuffled([1, 2, 3, 4], 17)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

  const report = panelReport(
    {
      version: 1,
      seed: 0,
      clips: [{ id: "clip-001", arm: "plain", file: "clips/clip-001.mp4", sha256: "test" }],
    },
    [
      { rater: "a", clipId: "clip-001", guess: "person", naturalness: 5, atMillis: 0 },
      { rater: "b", clipId: "clip-001", guess: "bot", naturalness: 3, atMillis: 0 },
      { rater: "c", clipId: "clip-001", guess: "person", naturalness: 4, atMillis: 0 },
    ],
  );

  expect(report.find((row) => row.arm === "plain")).toMatchObject({
    raters: 3,
    ratings: 3,
    personRate: 2 / 3,
    meanNaturalness: 4,
    naturalnessInterval: { high: 5, level: 0.95 },
  });
  expect(report.find((row) => row.arm === "plain")?.naturalnessInterval?.low).toBeCloseTo(
    1.51566,
    4,
  );
  expect(report.find((row) => row.arm === "tuned")).toMatchObject({
    ratings: 0,
    personRate: null,
    personRateInterval: null,
    meanNaturalness: null,
    completion: "awaiting ratings",
  });
});

it.live(
  "blind panel serves anonymous clips and durably rejects duplicate ratings without exposing arms",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "bench-panel-test-")));
        const video = join(directory, "source.mp4");

        yield* Effect.promise(() => writeFile(video, "synthetic clip bytes for HTTP route test"));

        const panel = yield* preparePanel({
          outputDirectory: join(directory, "panel"),
          seed: 9,
          clips: [
            { arm: "plain", path: video },
            { arm: "human", path: video },
          ],
        });

        const server = yield* servePanel({ directory: panel.directory });

        const sessionResponse = yield* Effect.promise(() =>
          fetch(`${server.url}api/session`, { method: "POST" }),
        );

        const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
        const session = yield* Effect.promise(() => sessionResponse.text());

        expect(session).not.toContain("plain");
        expect(session).not.toContain("human");
        expect(session).not.toContain("source.mp4");
        const input = { clipId: "clip-001", guess: "person", naturalness: 4 };

        const rating = () =>
          fetch(`${server.url}api/rating`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(input),
          });

        expect((yield* Effect.promise(rating)).status).toBe(200);
        expect((yield* Effect.promise(rating)).status).toBe(409);

        const stored = yield* Effect.promise(() =>
          readFile(join(panel.directory, "ratings.json"), "utf8"),
        );

        expect(JSON.parse(stored)).toHaveLength(1);
        expect((yield* Effect.promise(() => fetch(`${server.url}manifest.json`))).status).toBe(404);

        const range = yield* Effect.promise(() =>
          fetch(`${server.url}clip/clip-001`, { headers: { range: "bytes=0-8" } }),
        );

        expect(range.status).toBe(206);
        expect(yield* Effect.promise(() => range.text())).toBe("synthetic");
        expect(
          (yield* loadPanelReport(panel.directory)).reduce((total, arm) => total + arm.ratings, 0),
        ).toBe(1);
        yield* Effect.promise(() => mkdir(join(panel.directory, "ratings.pending.json")));

        const failed = yield* Effect.promise(() =>
          fetch(`${server.url}api/rating`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ clipId: "clip-002", guess: "bot", naturalness: 3 }),
          }),
        );

        expect(failed.ok).toBe(false);

        const resumed = yield* Effect.promise(() =>
          fetch(`${server.url}api/session`, { method: "POST", headers: { cookie } }),
        );

        const remaining = yield* Effect.promise(() => resumed.text());

        expect(remaining).toContain("clip-002");
        expect(
          (yield* loadPanelReport(panel.directory)).reduce((total, arm) => total + arm.ratings, 0),
        ).toBe(1);
      }),
    ),
);
