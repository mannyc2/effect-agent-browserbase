/**
 * Where a page's screen moves, from its screencast frames: each frame decoded and cut into
 * 16-pixel blocks, a block moving where a few of its pixels, sampled every other one, changed by
 * more than JPEG's noise in any color channel.
 * What moved among the frames before an input is the page's background, such as an idle
 * animation; foreground stillness ignores it.
 *
 * Frames are decoded with the JPEG decoder playwright-core bundles and exports as
 * `playwright-core/lib/utilsBundle`: effect-browser depends on nothing else, and the runtime has
 * no image decoder. That entry point has no types, so `utilsBundle.d.ts` declares what is used.
 */
// oxlint-disable-next-line typescript/triple-slash-reference -- a declaration of an untyped module cannot be imported, and every program that compiles this source needs it
/// <reference path="./utilsBundle.d.ts" />
import { jpegjs } from "playwright-core/lib/utilsBundle";

import type { Frame } from "../../Frame.ts";

/** A decoded frame: RGBA, `width` pixels a row. */
export type Picture = ReturnType<typeof jpegjs.decode>;

export const picture = (frame: Frame): Picture => jpegjs.decode(frame.data, { useTArray: true });

/** A sample changed where any color channel moved more than this, beyond JPEG's noise. */
const noise = 32;

/** The blocks where two pictures differ, by `row * columns + column`; -1 for different sizes. */
const moved = (from: Picture, to: Picture): ReadonlyArray<number> => {
  if (from.width !== to.width || from.height !== to.height) return [-1];
  const columns = Math.ceil(from.width / 16);
  const counts = new Map<number, number>();
  const differs = (at: number) => Math.abs((from.data[at] ?? 0) - (to.data[at] ?? 0)) > noise;

  for (let y = 0; y < from.height; y += 2)
    for (let x = 0; x < from.width; x += 2) {
      const at = (y * from.width + x) * 4;
      const block = Math.floor(y / 16) * columns + Math.floor(x / 16);

      if (differs(at) || differs(at + 1) || differs(at + 2))
        counts.set(block, (counts.get(block) ?? 0) + 1);
    }

  // At least three changed samples, so a stray one is no motion.
  return [...counts].flatMap(([block, count]) => (count >= 3 ? [block] : []));
};

/** The blocks that moved from one picture to the next and their neighbours; none past a resize. */
export const background = (pictures: ReadonlyArray<Picture>): ReadonlySet<number> => {
  const columns = Math.ceil((pictures[0]?.width ?? 0) / 16);

  const around = (block: number) =>
    [-1, 0, 1].flatMap((row) =>
      [-1, 0, 1]
        .filter((step) => block >= 0 && (block % columns) + step >= 0)
        .filter((step) => (block % columns) + step < columns)
        .map((step) => block + row * columns + step),
    );

  return new Set(
    pictures.flatMap((to, index) => moved(pictures[index - 1] ?? to, to).flatMap(around)),
  );
};

/** Whether anything moved from one picture to another outside the background. */
export const stirs = (from: Picture, to: Picture, mask: ReadonlySet<number>) =>
  moved(from, to).some((block) => !mask.has(block));
