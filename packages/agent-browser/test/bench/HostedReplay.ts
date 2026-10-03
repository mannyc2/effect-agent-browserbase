import { Effect } from "effect";

import type { DriftSite } from "../fixtures/DriftSite.ts";
import { prepareFixtureTunnel, quickTunnelUrl } from "./HostedGames.ts";
import { BenchError, type Journal } from "./Records.ts";

/** The original fixture ledger and one tunnel child remain owned by the caller's scope. */
export const prepareHostedReplay = Effect.fn("Bench.prepareHostedReplay")(function* (
  site: DriftSite,
  options: { readonly executable: string; readonly startupTimeoutMillis?: number },
) {
  const prepared = yield* prepareFixtureTunnel(site.url, options);

  return { site: { ...site, url: prepared.url }, publicUrl: prepared.url };
});

/** Hosted replay never substitutes a newly acquired loopback fixture after owner allocation. */
export const requireHostedReplayFixture = (journal: Journal, site?: DriftSite) =>
  journal.manifest.backend === "browserbase" &&
  (site === undefined || quickTunnelUrl(site.url) !== site.url)
    ? Effect.fail(
        new BenchError({
          operation: "replay",
          message: "Prepare the hosted replay fixture before acquiring the owner.",
        }),
      )
    : Effect.void;
