# Deploying this site

The site is built on the CAFE stack: **C**loudflare, **A**lchemy, **F**oldkit and **E**ffect. It is a Foldkit app, an Elm-architecture frontend on Effect, served by a Cloudflare Worker with the replays in an R2 bucket, and deployed by an Alchemy stack written in Effect.

## The stack

`site/alchemy.run.ts` declares two resources:

- `Replays`, the R2 bucket `effect-browser-replays`, holding packed replays under `<id>/`;
- `Site`, a `Cloudflare.Website.Foldkit` that builds the app with Vite and deploys it as static assets behind `src/worker.ts`, with the bucket bound as `REPLAYS`.

The build writes each page's markdown, `llms.txt`, `llms-full.txt`, `/api/v1/pages.json` and `robots.txt` beside the app, and one HTML entry per page whose head carries its title, summary and a `rel="alternate"` link to its markdown. The Worker runs first on page paths and `/replays/*`. A replay's files come from the bucket, with range requests so the video seeks. A page requested with `Accept: text/markdown` gets its markdown; requested as HTML, it gets a `Link` header naming its markdown. Everything else is the static build, and unmatched paths are served `index.html`, so the app's router takes over.

## Deploy

`bun run deploy` runs the local Alchemy CLI on Node, which builds the app and deploys the Worker and the bucket. The deploy and destroy scripts clear Bun's package-manager hints so Alchemy uses the installed Node platform services. `bun run deploy --help` checks that entry point without changing Cloudflare resources. `bun run upload -- polymarket` then puts `public/replays/polymarket/` into the bucket. The build on its own needs no account:

:::Example
```sh
cd site
bun run build
ls -1 dist dist/docs
```

Run on 11 October 2026, it printed this, Vite's note about the size of the app's one script included:

```text output
$ vp build
transforming...
✓ 501 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   1.00 kB │ gzip:   0.59 kB
dist/assets/index-Af68hcIh.css   38.30 kB │ gzip:   7.85 kB
dist/assets/index-CpFJbfPY.js   503.43 kB │ gzip: 160.69 kB

✓ built in 707ms
[plugin builtin:vite-reporter]
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.

dist:
404.md
api
assets
demo.html
demo.md
docs
index.html
index.md
llms-full.txt
llms.txt
robots.txt
try.html

dist/docs:
agent-tools.html
agent-tools.md
browserbase.html
browserbase.md
deploying.html
deploying.md
for-agents.html
for-agents.md
get-started.html
get-started.md
moments-and-narration.html
moments-and-narration.md
run-the-demo.html
run-the-demo.md
watched-browsing.html
watched-browsing.md
```
:::

Alchemy reads Cloudflare credentials from its profile (`alchemy profile edit --add Cloudflare`) or from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The upload script reads those two variables, and its token needs R2 write access; it decodes the replay before it uploads anything. Replays stay out of git and out of the build: `bun run demo take` packs them into `public/replays/`, which the dev server serves and the upload script publishes.

## Locally

`bun run dev` serves the same app with Vite, the replays from `public/replays/`, the markdown and llms.txt from the same sources the build emits, and the local runner the [Try page](/try) uses. No Cloudflare account is needed to work on the site or record a take.
