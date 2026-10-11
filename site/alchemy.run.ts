// The site on Cloudflare: the Foldkit build as static assets behind a Worker, and an R2 bucket for
// the replays, which are too large to ship with the build. `bun run deploy` builds and deploys it;
// `bun run upload -- <id>` puts a packed replay in the bucket. See docs/deploying.md.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "EffectBrowserSite",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const replays = yield* Cloudflare.R2.Bucket("Replays", { name: "effect-browser-replays" });

    const site = yield* Cloudflare.Website.Foldkit("Site", {
      main: "src/worker.ts",
      env: { REPLAYS: replays },
      assets: {
        notFoundHandling: "single-page-application",
        // The Worker answers markdown requests for pages and streams replays from the bucket.
        runWorkerFirst: ["/", "/docs/*", "/demo", "/try", "/replay/*", "/replays/*"],
      },
    });

    return { url: site.url, replays: replays.bucketName };
  }),
);
