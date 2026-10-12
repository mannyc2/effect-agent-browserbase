# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: true

## Project Notes

The repository's own rules, in [`../AGENTS.md`](../AGENTS.md), apply here too: exact versions in every manifest, no paid calls without the person's say, and downstream applications are "the consumer", never named.

### Recording a take for your person

If your person asked you to record a take of the demo on their machine:

1. From the repository root: `bun install`, then `./node_modules/.bin/playwright-core install chromium`.
2. Ask your person for an OpenRouter API key and a spending cap in USD, at most 5. A take calls models, so do not record one without both. Export `OPENROUTER_API_KEY` and `EFFECT_BROWSER_BENCH_LIVE=1` in their shell, never in a file you commit.
3. In `site/`, run `bun run dev` and have them open `http://localhost:5173/try`, which records with the model and cap they enter; or record from the terminal with `bun run demo take --max-usd <cap>`.
4. A take takes one to three minutes and is packed under `public/replays/<id>/`, which git ignores. It plays at `/replay/<id>`.

### Layout

- `src/main.ts`: the application: routes, the root Model, and the pages' views. `src/entry.ts` runs it.
- `src/pages.ts`: the docs pages in navigation order, with each one's title and summary. `docs/<slug>.md` holds each page's body, opening with a `# Title` that matches.
- `src/docs.ts`: renders a page's markdown. `::Replay{id="…"}` in a page places a replay's player in the prose.
- `src/player/`: the replay player, a Submodel. `src/replay.ts` is the packed replay's schema.
- `src/page/try.ts`: the Try page, a Submodel that talks to the local runner through `src/local.ts`.
- `agent.ts`: the Vite plugin that serves and builds the agent surface: each page's markdown, `llms.txt`, `llms-full.txt`, `/api/v1/pages.json`, `robots.txt`, `404.md`, and one HTML entry per page.
- `src/serve.ts` and `src/worker.ts`: the deployed Worker, which answers `Accept: text/markdown`, adds a `Link` header naming a page's markdown, and streams replays from R2.
- `alchemy.run.ts`: the Cloudflare stack. `upload.ts` puts a replay in its bucket.
- `demo/`: the demos' runner: the take, the voice, the packer and the dev server's `/local` API. `show.ts` is what the demos share: the agent's run with moments of the page in its thread, and a persona that makes what it says beside its tool calls the video's voice. `polymarket.ts` and `casino.ts` are the two demos.
- `demo/casino/`: the casino demo's own sites: the casino (`casino.html`), its slot (`slot.html`, drawn on a canvas), the slot's maths (`slot.ts`) and the server that serves both and records every spin (`site.ts`). Nothing in them may tell the agent they were made for the demo.

### Adding a docs page

Write `docs/<slug>.md` opening with `# <Title>`, then add the page to `pages` in `src/pages.ts`. The sidebar, the pager, the agent surface and the tests pick it up from there. Link to other pages by their path, such as `/docs/get-started`; the markdown for agents points those links at the `.md`.

### Checks

From `site/`: `bun run check`, `bun run test` and `bun run build`. From the repository root: `bun run fmt` and `bun run lint`. Story tests cover `update`, Scene tests cover views; `test/fixture.ts` is a small narrated replay for both.

### Deploying

Deploying and uploading replays publish to the owner's Cloudflare account; do neither without the owner. [docs/deploying.md](docs/deploying.md) has the steps.
