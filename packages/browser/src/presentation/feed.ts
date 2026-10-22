/** The capture feed's lifecycle: reset drops evidence without undoing readiness or retirement. */
import type { Frame } from "../Frame.ts";

export type State =
  | { readonly _tag: "Warming" }
  | { readonly _tag: "Ready"; readonly latest: Frame | undefined }
  | { readonly _tag: "Stopped" };

export type Input =
  | { readonly _tag: "Paint"; readonly frame: Frame }
  | { readonly _tag: "Reset" | "Stop" };

export const initial: State = { _tag: "Warming" };

export const step = (state: State, input: Input): State => {
  if (state._tag === "Stopped") return state;
  if (input._tag === "Stop") return { _tag: "Stopped" };
  if (input._tag === "Paint") return { _tag: "Ready", latest: input.frame };

  return state._tag === "Ready" ? { _tag: "Ready", latest: undefined } : state;
};
