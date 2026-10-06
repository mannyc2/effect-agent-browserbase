# Repository guide

Three packages and a bench in one Bun workspace: `packages/browser` (`effect-browser`),
`packages/browserbase` (`effect-browserbase`), the optional `packages/human-strokes`
(`effect-browser-human-strokes`, MIT code with CC BY 4.0 stroke data) and the private `bench`. Read
`README.md`, `CONTRIBUTING.md` and the neighbouring tests before editing; `docs/STATUS.md` is the
current state.

## Code

- Idiomatic Effect 4: services with `Context.Service` and layers, scoped resources, typed errors
  with reasons, `Schema` for data at boundaries, `Config.Redacted` for secrets. Read
  `node_modules/effect/AGENTS.md` before writing Effect code.
- Few files, each with one clear job. Prefer deleting code to adding options. A module's doc
  comment says what it is for.
- `effect-browser` depends on `effect` and `playwright-core` only; `effect-browserbase` and
  `effect-browser-human-strokes` reach it only through its public entry points. Tests stay in their
  package's `test/`.
- Fix a lint finding or Effect diagnostic rather than suppress it. `bun run fmt` formats;
  `oxlint -c lint/.oxlintrc.json --fix <files>` fixes the stylistic rules `fmt` leaves alone.
- `bun run ready` is the gate CI runs. Check its exit code, not piped output.

## Safety

- Model calls and hosted Browserbase sessions cost money. Only the bench makes them, and only
  behind `EFFECT_BROWSER_BENCH_LIVE=1` or `EFFECT_BROWSER_BENCH_HOSTED=1`; no maintenance request
  authorizes setting either. Tests use scripted models and a fake Browserbase API.
- Keep API keys, connect URLs and Live View URLs out of model inputs, logs, commits and PRs. Never
  commit provider account identifiers such as project or session ids; document how to find them.
- Refer to downstream applications as "the consumer"; do not name them in this repository.
- Ordinary CI is read-only: no `pull_request_target`, no hosted or model credentials, no
  publication.
- `docs/RELEASING.md` describes a manual, tag-scoped npm workflow. Preparing or testing it does
  not authorize publishing, registering a package, changing account permissions or creating tags.
- Preserve history: normal commits, never force-push or rewrite accepted history. Keep the
  `ts-release-prepared/*` and `ts-release-journal/*` branches; they record the 0.2 releases.
- Retarget PRs stacked on a branch before deleting it.
