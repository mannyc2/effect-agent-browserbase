import { Effect } from "effect";
import type { Page } from "effect-browser/browser";

import type { GameKind } from "./GameCore.ts";
import { type GameSite, GameSiteError, type HostGameState } from "./GameSite.ts";

/** Only polls host truth; an action whose acknowledgement is uncertain is never replayed. */
export const waitForGame = Effect.fn("waitForGame")(function* (
  site: GameSite,
  kind: GameKind,
  predicate: (state: HostGameState) => boolean,
  operation: string,
  timeoutMillis = 6000,
) {
  for (let elapsed = 0; elapsed <= timeoutMillis; elapsed += 25) {
    const failures = site.failures();

    if (failures.length > 0)
      return yield* GameSiteError.make({ operation, cause: new Error(failures.join("; ")) });
    const state = site.state(kind);

    if (predicate(state)) return state;
    yield* Effect.sleep("25 millis");
  }

  return yield* GameSiteError.make({ operation, cause: new Error("Game truth deadline exceeded") });
});

export const enterGame = Effect.fn("enterGame")(function* (
  page: Page,
  site: GameSite,
  kind: GameKind,
) {
  yield* page.navigate({ url: site.url });
  yield* page.click({ selector: "#accept-cookies" });
  yield* page.click({ selector: "#confirm-age" });
  yield* page.click({ selector: `#play-${kind}` });
  yield* waitForGame(site, kind, (state) => state.ready && state.focused, "game ready and focused");
  const frames = yield* page.listFrames();
  const info = frames.find((frame) => frame.url.startsWith(`${site.frameOrigin}/frame/${kind}?`));

  if (info === undefined)
    return yield* GameSiteError.make({
      operation: "issue game frame",
      cause: new Error("No cross-site game frame"),
    });

  return yield* page.frame(info);
});
