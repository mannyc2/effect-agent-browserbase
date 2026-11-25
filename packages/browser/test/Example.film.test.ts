// The film example, run on local Chromium: what it films is what its glue says.
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { demo, film } from "../examples/film.ts";
import type * as Film from "../src/film/Film.ts";
import * as Chromium from "../src/providers/Chromium.ts";

it.effect(
  "films three seconds on held time: a press on its frame, an eased scroll, PNG frames",
  () =>
    Effect.gen(function* () {
      const shots: Array<Film.Shot> = [];
      const summary = yield* film(demo, (shot) => Effect.sync(() => shots.push(shot)));

      assert.strictEqual(summary.frames, 90);
      assert.deepStrictEqual(
        summary.sent.map(({ t, label, target }) => [t, label, target?.name]),
        [[1000, "press", "Copy"]],
      );
      assert.strictEqual(shots[30]?.sent.length, 1);
      assert.isTrue(shots.every(({ image }) => image.mediaType === "image/png"));
      assert.deepStrictEqual([shots[0]?.image.width, shots[0]?.image.height], [640, 360]);
      const scrolls = shots.map(({ scroll }) => scroll?.y ?? -1);

      assert.strictEqual(scrolls[0], 0);
      assert.strictEqual(scrolls.at(-1), 200);
      assert.isTrue(scrolls.every((y, index) => index === 0 || y >= (scrolls[index - 1] ?? y)));
      assert.deepStrictEqual(summary.passages, []);
    }).pipe(
      Effect.provide(Chromium.layer({ viewport: { width: 640, height: 360 }, pageTime: true })),
      Effect.timeout("60 seconds"),
    ),
);
