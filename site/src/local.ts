// The local runner's contract: what the Try page asks the dev server on a visitor's own machine to
// do, and what it reports back. Only `bun run dev` serves it, under /local; a deployed site has no
// runner, so a failed status request means the page is not running locally.
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

/** One take of the demo: the model the agent and narrator use, and what the take may spend. */
export const Take = Schema.Struct({
  /** An OpenRouter model id, for the agent and the narrator. */
  model: Schema.String,
  /** USD for the agent, narrator and voice together; the take stops admitting calls past it. */
  maxUsd: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5)),
});
export type Take = typeof Take.Type;

export const RunnerStatus = Schema.Struct({
  /** What a take still needs on this machine, in words, such as an API key; empty when ready. */
  missing: Schema.Array(Schema.String),
  defaults: Take,
});
export type RunnerStatus = typeof RunnerStatus.Type;

/** What the runner printed, newest last, bounded. */
const log = Schema.Array(Schema.String);

export const TakeState = Schema.Union([
  Schema.TaggedStruct("Running", { log }),
  /** Packed under /replays/<replay>/, which the player loads. */
  Schema.TaggedStruct("Packed", { log, replay: Schema.String }),
  Schema.TaggedStruct("Failed", { log, reason: Schema.String }),
]);
export type TakeState = typeof TakeState.Type;

export class LocalRunner extends HttpApiGroup.make("LocalRunner")
  .add(HttpApiEndpoint.get("status", "/local/runner", { success: RunnerStatus }))
  .add(
    HttpApiEndpoint.post("start", "/local/takes", {
      payload: Take,
      success: Schema.Struct({ id: Schema.String }),
    }),
  )
  .add(
    HttpApiEndpoint.get("take", "/local/takes/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: TakeState,
    }),
  ) {}

export class LocalApi extends HttpApi.make("LocalApi").add(LocalRunner) {}
