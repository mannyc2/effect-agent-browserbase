/**
 * `effect-browser/ai`'s browser tools for a Yielded agent: the same toolkits, and a layer that also
 * gives Yielded's run what the model sees of the page, as its `RunContextPreparation`.
 *
 * With `vision` `true`, the default, `"ask"` or `"page"`, the pictures `BrowserTools.Pictures` gives
 * before each turn are the run's transient context, which a run's own `transientContext` option
 * replaces. With `vision: "moments"`, the model's thread holds, after each turn's tool results, a
 * moment of the current tab since the turn before: what happened, what changed. These stable
 * accounts can be compacted. The latest three moments' pictures follow as reference messages
 * labeled by turn, with their frame times. A run's own `context` option replaces the accounts' hook;
 * its `transientContext` replaces the pictures. If the current page is lost or its moment has no
 * usable picture, preparation fails with `AgentInputError` before another model call.
 *
 * `Seed` is a finished run's thread with the tools' state, to continue from.
 *
 * @stability stable
 * @since 0.3.0
 */
import { RunContextPreparation } from "@yielded/agent/run-options";
import { Effect, Layer, Schema } from "effect";
import { BrowserTools, type PageControl, Tabs } from "effect-browser/ai";
import { Zoom } from "effect-browser/Page";
import { Snapshot } from "effect-browser/Snapshot";
import type { Moment } from "effect-browser/timeline";
import { Prompt } from "effect/ai";

import * as Preparation from "./internal/moments.ts";
import * as Moments from "./Moments.ts";

/**
 * What the model sees of the page: `BrowserTools.Vision`, or `"moments"`, in its thread, what the
 * tab did since its previous turn, with frames from a running screencast, or one screenshot
 * without one.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Vision = BrowserTools.Vision | "moments";

/**
 * @stability stable
 * @category options
 * @since 0.3.0
 */
export interface LayerOptions extends Omit<BrowserTools.LayerOptions, "vision"> {
  /** What the model sees of the page; `true` by default. Moments' frames keep the CSS pixels. */
  readonly vision?: Vision | undefined;
  readonly initialMoments?: Moments.Moments | undefined;
  /** With moments, called with each moment as the model is first shown it, as for a recording. */
  readonly onMoment?: ((moment: Moment.Moment) => Effect.Effect<void>) | undefined;
}

// Without pictures, an application's own context preparation stays as it is.
const preparation = (
  vision: Vision,
  { initialMoments, onMoment }: Pick<LayerOptions, "initialMoments" | "onMoment">,
) =>
  vision === false
    ? Layer.empty
    : Layer.effect(
        RunContextPreparation,
        Effect.gen(function* () {
          const pictures = yield* BrowserTools.Pictures;

          if (vision !== "moments") return { transientContext: { load: () => pictures.next } };

          return yield* Preparation.make(
            (yield* BrowserTools.Controller).look,
            pictures.crops,
            onMoment ?? (() => Effect.void),
            initialMoments,
          );
        }),
      );

/** The tools of one mode, with a layer that also prepares a Yielded run's context. */
const binding = <Tools, Out, E, In>(tools: {
  readonly toolkit: Tools;
  readonly layer: (
    target: PageControl.Target,
    options?: BrowserTools.LayerOptions,
  ) => Layer.Layer<Out, E, In>;
}) => ({
  toolkit: tools.toolkit,
  /**
   * Every tool's handler, `BrowserTools.Pictures` and `BrowserTools.Controller` for one run on
   * `target`, and with `vision` the run's context preparation.
   */
  layer: (
    target: PageControl.Target,
    { vision = true, initialMoments, onMoment, ...options }: LayerOptions = {},
  ) =>
    preparation(vision, { initialMoments, onMoment }).pipe(
      Layer.provideMerge(
        tools.layer(target, { ...options, vision: vision === "moments" ? true : vision }),
      ),
    ),
});

const singleTools = binding(BrowserTools.make({ mode: "single" }));

const batchedTools = binding(BrowserTools.make());

/**
 * The tools and their layer. `"batched"`, the default, lets `act` take up to eight actions; with
 * `"single"`, it takes one.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export function make(options?: { readonly mode?: "batched" }): typeof batchedTools;
export function make(options: { readonly mode: "single" }): typeof singleTools;

export function make(options: { readonly mode?: "single" | "batched" } = {}) {
  return options.mode === "single" ? singleTools : batchedTools;
}

/**
 * Finished conversation and adapter context; in-flight agent runs remain owned by Yielded.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Seed extends Schema.Class<Seed>("@effect-browser/yielded/YieldedTools/Seed")({
  history: Prompt.Prompt,
  threadId: Schema.optional(Schema.String),
  tabs: Schema.optional(Tabs.Tabs),
  moments: Schema.optional(Moments.Moments),
  zooms: Schema.Array(Zoom),
  observations: Schema.Array(Snapshot),
}) {}

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const load = Schema.decodeUnknownEffect(Schema.toCodecJson(Seed));
