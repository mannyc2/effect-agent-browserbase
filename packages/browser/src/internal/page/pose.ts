/**
 * The page's poses: one lease at a time, each `set` one call to the page in the page's turn, as an
 * action takes it, so no action resolves a target that a pose then moves. The lease's scope takes
 * every pose off. See `Pose`.
 */
import { Effect, Schema, type Scope } from "effect";

import { type BrowserError, StaleRef } from "../../BrowserError.ts";
import { Pose, type Poses } from "../../Pose.ts";
import { type Bridge, scriptCall } from "./bridge.ts";
import { decodeWith, failWith, type PageContext, refuse } from "./context.ts";
import { poseRequest } from "./pose.inpage.ts";

/** What posing answered: nothing, or the ref it could not pose and why. */
export const Posed = Schema.Struct({
  stale: Schema.optional(Schema.String),
  invalid: Schema.optional(Schema.String),
});

export const make = (page: PageContext, bridge: Bridge) => {
  const { lane, owned, span, within } = page;
  let open = false;

  /** The page's requests for `poses`, each part left out made the one that changes nothing. */
  const requests = Effect.fnUntraced(function* (operation: string, poses: ReadonlyArray<Pose>) {
    const decoded = yield* Schema.decodeEffect(Schema.Array(Pose))(poses).pipe(
      Effect.catch(() => refuse(operation, "each pose is a ref and finite numbers")),
    );

    if (decoded.length > 256)
      return yield* refuse(operation, "at most 256 elements are posed at once");

    return decoded.map(poseRequest);
  });

  /** Fail as the page's answer says, if it posed nothing. */
  const answered = (operation: string, posed: typeof Posed.Type) =>
    posed.stale !== undefined
      ? failWith(operation, new StaleRef({ ref: posed.stale }))
      : posed.invalid !== undefined
        ? refuse(operation, posed.invalid)
        : Effect.void;

  const send = (operation: string, script: string) =>
    lane.write(
      operation,
      page.settings.actionTimeout,
    )(
      bridge.evaluate(operation, script).pipe(
        Effect.flatMap(decodeWith(operation, Posed)),
        Effect.flatMap((posed) => answered(operation, posed)),
        Effect.tap(() => Effect.sync(page.noteInput)),
        within(operation),
      ),
    );

  const set = (poses: ReadonlyArray<Pose>) =>
    requests("pose", poses).pipe(
      Effect.flatMap((made) => send("pose", scriptCall("pose", made))),
      span("Poses.set"),
      owned,
    );

  const lease: Effect.Effect<Poses, BrowserError, Scope.Scope> = Effect.gen(function* () {
    if (open) return yield* refuse("pose", "the page's poses are open already");
    open = true;
    yield* Effect.addFinalizer(() =>
      send("pose", scriptCall("unpose")).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => (open = false))),
      ),
    );

    return { set };
  });

  return { lease, open: () => open, requests, answered };
};

export type Posing = ReturnType<typeof make>;
