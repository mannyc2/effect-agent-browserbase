/** The capture's one lifecycle: retirement is absorbing and retains its first failure. */
import type { BrowserError } from "../../BrowserError.ts";

export type State =
  | { readonly _tag: "Capturing" }
  | { readonly _tag: "Paused" }
  | { readonly _tag: "Stopped"; readonly failure: BrowserError | undefined };

export type Input =
  | { readonly _tag: "Pause" | "Resume" }
  | { readonly _tag: "Stop"; readonly failure?: BrowserError | undefined };

export const initial: State = { _tag: "Capturing" };

export const step = (state: State, input: Input): State => {
  if (input._tag === "Stop")
    return {
      _tag: "Stopped",
      failure: state._tag === "Stopped" ? (state.failure ?? input.failure) : input.failure,
    };
  if (state._tag === "Stopped") return state;

  return { _tag: input._tag === "Pause" ? "Paused" : "Capturing" };
};

export const failureOf = (state: State) => (state._tag === "Stopped" ? state.failure : undefined);
