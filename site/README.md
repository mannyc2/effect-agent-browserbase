# site

The docs site for effect-browser, its narrated Polymarket demo, and a player for recorded runs. A
[Foldkit](https://foldkit.dev) app on Cloudflare, deployed with [Alchemy](https://alchemy.run): the
CAFE stack.

```sh
bun run dev      # the site, with the local runner that records takes, at http://localhost:5173
bun run test     # Story and Scene tests, and the agent surface and Worker
bun run build    # the static build, with every page's markdown beside it
bun run demo take --max-usd 0.5   # record a narrated take from the terminal
```

Recording calls models: set `OPENROUTER_API_KEY` and `EFFECT_BROWSER_BENCH_LIVE=1` first. Takes are
packed under `public/replays/<id>/` and play at `/replay/<id>`.

Every page is also markdown, at its path plus `.md` or with `Accept: text/markdown`, and
`/llms.txt` lists them. [docs/for-agents.md](docs/for-agents.md) describes the surface, and
[AGENTS.md](AGENTS.md) is for coding agents working here. [docs/deploying.md](docs/deploying.md)
covers the Cloudflare stack.
