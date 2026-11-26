/** The crops `zoom` took, as the model is shown them before its next turn. */
import { Prompt } from "effect/ai";

import type { Zoom } from "../../Frame.ts";

/** At most this many crops are shown at once: the latest. */
const maxZooms = 8;

/**
 * The crops of `page` taken since the last turn: the latest, each with its origin, in pictures of
 * `scale` pixels to a CSS pixel.
 */
export const cropped = (
  crops: ReadonlyArray<Zoom>,
  page: string,
  scale = 1,
): ReadonlyArray<Prompt.UserMessagePart> => {
  const current = crops.filter((crop) => crop.page === page);
  const kept = current.slice(-maxZooms);
  const at = (value: number) => Math.round(value * scale);
  const unit = scale === 1 ? "CSS pixels" : "screenshot pixels";

  return [
    ...kept.flatMap(({ region, image }) => [
      Prompt.makePart("text", {
        text: `Zoom: viewport origin (${at(region.x)}, ${at(region.y)}), ${at(region.width)}x${at(region.height)} ${unit}. Add this origin to a point in the crop for a viewport click.`,
      }),
      Prompt.makePart("file", { mediaType: image.mediaType, data: image.data }),
    ]),
    ...(current.length > kept.length
      ? [
          Prompt.makePart("text", {
            text: `${current.length - kept.length} earlier crops were left out.`,
          }),
        ]
      : []),
  ];
};
