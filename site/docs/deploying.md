# Deploying this site

The site is built on the CAFE stack: **C**loudflare, **A**lchemy, **F**oldkit and **E**ffect. It is a Foldkit app, an Elm-architecture frontend on Effect, served by a Cloudflare Worker with the replays in an R2 bucket, and deployed by an Alchemy stack written in Effect.

## The stack

`site/alchemy.run.ts` declares two resources:

- `Replays`, the R2 bucket `effect-browser-replays`, holding packed replays under `<id>/`;
- `Site`, a `Cloudflare.Website.Foldkit` that builds the app with Vite and deploys it as static assets behind `src/worker.ts`, with the bucket bound as `REPLAYS`.

The build writes each page's markdown, `llms.txt`, `llms-full.txt`, `/api/v1/pages.json` and `robots.txt` beside the app, and one HTML entry per page whose head carries its title, summary and a `rel="alternate"` link to its markdown. The Worker runs first on page paths and `/replays/*`. A replay's files come from the bucket, with range requests so the video seeks. A page requested with `Accept: text/markdown` gets its markdown; requested as HTML, it gets a `Link` header naming its markdown. Everything else is the static build, and unmatched paths are served `index.html`, so the app's router takes over.

## Deploy

```sh
cd site
bun run deploy                 # alchemy deploy: builds the app and deploys the Worker and bucket
bun run upload -- polymarket   # puts public/replays/polymarket/ into the bucket
```

Alchemy reads Cloudflare credentials from its profile (`alchemy profile edit --add Cloudflare`) or from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The upload script reads those two variables, and its token needs R2 write access; it decodes the replay before it uploads anything. Replays stay out of git and out of the build: `bun run demo take` packs them into `public/replays/`, which the dev server serves and the upload script publishes.

## Locally

`bun run dev` serves the same app with Vite, the replays from `public/replays/`, the markdown and llms.txt from the same sources the build emits, and the local runner the [Try page](/try) uses. No Cloudflare account is needed to work on the site or record a take.
