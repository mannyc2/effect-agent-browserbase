// This Node-only layer owns one fixed package asset without adding a platform dependency or
// requiring a caller filesystem service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFile } from "node:fs/promises";

import { Effect, Layer, Random, Result } from "effect";
import type { Browser } from "effect-browser/Browser";
import * as Motion from "effect-browser/Motion";

import { DataError, index, inflate, retarget, select } from "./internal/strokes.ts";

const read = Effect.tryPromise({
  try: (signal) => readFile(new URL("../data/strokes.bin.br", import.meta.url), { signal }),
  catch: () =>
    new DataError({
      reason: "Read",
      detail: "The bundled human-stroke asset could not be read.",
    }),
});

const load = Effect.gen(function* () {
  // No binding here holds the compressed asset, so the planner's closure keeps only the payload.
  const decoded = index(yield* Effect.flatMap(read, inflate));

  if (Result.isFailure(decoded)) return yield* decoded.failure;
  const data = decoded.success;

  const plan: Motion.Service["plan"] = Effect.fnUntraced(function* (from, to) {
    const scale = Math.max(1, Math.abs(from.x), Math.abs(from.y), Math.abs(to.x), Math.abs(to.y));

    const distance =
      Math.hypot(to.x / scale - from.x / scale, to.y / scale - from.y / scale) * scale;

    if (distance < 2) return [{ ...to, afterMillis: 0 }];
    const record = select(data, distance, yield* Random.next);

    return retarget(data, record, from, to, (yield* Random.next) < 0.5);
  });

  return { plan } satisfies Motion.Service;
});

/**
 * Replace pointer planning while constructing the browser; loading has no network or path options.
 * A browser reads its planner once, when built, so this layer must be provided to the layer that
 * builds the browser. Merged beside it, the browser silently keeps the default planner.
 */
export const layer: Layer.Layer<never, DataError> = Layer.effect(Motion.Motion, load);

/**
 * Give a browser layer recorded strokes: `HumanStrokes.provideTo(Chromium.layer(options))`.
 * Only a layer that builds the `Browser` is accepted, the one place the planner is read.
 */
export const provideTo = <A, E, R>(
  browser: Layer.Layer<A, E, R> & (Browser extends A ? unknown : "a layer that builds a Browser"),
): Layer.Layer<A, E | DataError, R> => Layer.provide(browser, layer);
