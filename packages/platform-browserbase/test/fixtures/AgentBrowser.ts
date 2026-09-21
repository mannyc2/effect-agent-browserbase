import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/adapter";
import { Effect, Layer } from "effect";
import { InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

// The canonical browser fixture belongs to the generic package. This adapter suite
// borrows it through a relative test-only path, never through production source.
import {
  account,
  localLaunch,
  type localBrowser,
} from "../../../browserbase/test/fixtures/LocalBrowser.ts";

export const agentPolicy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 100,
  maxElapsedMillis: 120000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

/** One adapter host over the shared local-process fixture and its scripted control plane. */
export const withAgentBrowser = <A, E, R>(
  fixture: Effect.Success<typeof localBrowser>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      BrowserbaseInteractiveHost.layer({
        launch: localLaunch,
        actionTimeoutMillis: 5000,
      }).pipe(Layer.provide(account)),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fixture.fetch),
  );
