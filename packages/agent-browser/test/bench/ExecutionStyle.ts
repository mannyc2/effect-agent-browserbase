import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { Effect, Schema } from "effect";
import { MotionProfile, Performed } from "effect-browser/plan-data";

import { BenchError } from "./Records.ts";

export interface StyleOptions {
  readonly style?: "plain" | "performed";
  readonly motionProfile?: MotionProfile;
}

/** Policy files contain bounded public motion data, not a measured-human claim. */
export const readMotionProfile = Effect.fn("Bench.readMotionProfile")(function* (file: string) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);

      try {
        const details = await handle.stat();

        if (!details.isFile() || details.size > 65536)
          throw new Error("Motion profile must be a bounded file");
        const buffer = Buffer.alloc(65537);
        const result = await handle.read(buffer, 0, buffer.length, 0);

        if (result.bytesRead !== details.size)
          throw new Error("Motion profile changed during read");

        return buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new BenchError({
        operation: "motion profile",
        message: "Cannot read a bounded motion profile.",
      }),
  });

  return yield* Schema.decodeEffect(Schema.fromJsonString(MotionProfile))(text);
});

/** Refuse selections that would print a supplied policy without applying it. */
export const validateMotionSelection = (options: {
  readonly scene: string;
  readonly driver?: string;
  readonly style?: string;
  readonly motionProfile?: MotionProfile;
}) => {
  const supported =
    options.scene === "busy" ||
    options.scene === "typing" ||
    options.scene === "game-segment" ||
    (options.scene === "games-operability" && options.driver === "canvas-click");

  return options.motionProfile === undefined || (options.style === "performed" && supported)
    ? Effect.void
    : Effect.fail(
        new BenchError({
          operation: "motion profile",
          message:
            "Motion profiles require performed busy, typing, game-segment or canvas-click operability.",
        }),
      );
};

export const executionStyle = Effect.fnUntraced(function* (options: StyleOptions, seed: number) {
  if (options.style !== "performed") {
    if (options.motionProfile !== undefined)
      return yield* new BenchError({
        operation: "motion profile",
        message: "A motion profile requires performed execution.",
      });

    return "plain" as const;
  }

  return yield* Schema.decodeEffect(Performed)({
    seed,
    ...(options.motionProfile === undefined ? {} : { motion: options.motionProfile }),
  });
});
