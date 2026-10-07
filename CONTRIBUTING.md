# Contributing

Open a focused PR against `main` that explains the change and how it was checked. CI runs
`bun run ready` on every PR.

## Toolchain

| Input                | Pin                          |
| -------------------- | ---------------------------- |
| Node                 | 24.14.1 (`.node-version`)    |
| Bun                  | 1.4.2                        |
| Effect               | 4.0.0                        |
| Playwright           | playwright-core 1.63.0       |
| TypeScript / Vite+   | 7.0.2 / 0.3.2                |
| Effect tsgo / Oxlint | 0.45.0 / 1.82.0              |

Every manifest names exact versions and `bun.lock` is committed. On a host with a different Node or
Bun, `toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"` installs the
pinned ones into `.work/toolchain` (linux-x64, checked against pinned digests).

## Working

```sh
bun install --frozen-lockfile --ignore-scripts
bun run patch:tsgo                  # Effect diagnostics in tsc and oxlint
./node_modules/.bin/playwright-core install chromium
./node_modules/.bin/vp hooks enable # format check, lint and typecheck before each commit

bun run ready                       # fmt check, lint, typecheck, test, build
```

- `bun run fmt` formats. `oxlint -c lint/.oxlintrc.json --fix <files>` fixes the stylistic rules
  that `fmt` leaves alone. Fix a lint finding or Effect diagnostic rather than suppress it.
- Read `node_modules/effect/AGENTS.md` before writing Effect code.
- Tests live in each package's `test/` and run against a real local Chromium with pages served by
  the test itself. Scripted models stand in for real ones: no test calls a model or a hosted browser.
- The bench (`bench/`) is the place for evidence about models; its README says how to run it.

## Keeping it small

- **Size.** A module holds at most 600 lines of code and a function at most 150, falling to 100;
  lint counts code only. The exceptions in `lint/.oxlintrc.json` sit at each file's size when the
  limits came in. Lower one when a change shrinks its file, and never raise one.
- **Exceptions say why.** A comment that switches a check off gives its reason after ` -- `, as
  in `// oxlint-disable-next-line <rule> -- <why this site is an exception>`. Lint enforces it.
- **A PR says what it deletes,** the source and test lines it adds and removes, the public names
  it adds and removes, and any check it adds or exception it lowers. A PR that only adds says
  why. `git diff --shortstat origin/main -- 'packages/*/src/*'` counts source lines, and
  `'packages/*/test/*'` test lines.
- **Tests earn their place.** A rule over many inputs gets a property test (`it.prop` with
  `effect/Arbitrary`); anything with history gets a model test. Before trusting a new test, plant
  the bug it guards against and watch it fail. Don't pin wording, such as a prompt's exact text.

## Layout

- `packages/browser` (`effect-browser`): the browser, pages, snapshots, frames, events, tools, the
  agent and moments. It depends on `effect` and `playwright-core` only. Its public modules are flat
  in `src/`; `src/internal/` is grouped by domain: page, pictures, input, reading, timeline and
  agent. Code that runs inside the page sits in `*.inpage.ts` parts, each one self-contained
  function that the bridge in `internal/page/bridge.ts` composes into the injected script.
- `packages/browserbase` (`effect-browserbase`): the Browserbase client and sessions as a
  `Browser`. It depends on `effect-browser` through its public entry points.
- `packages/human-strokes` (`effect-browser-human-strokes`): an optional pointer planner over
  recorded human strokes. It depends on `effect-browser` through its public entry points only. Its
  code is MIT; its bundled stroke data is CC BY 4.0, with attribution in its README and
  `LICENSE-data`.
- `bench`: private graded tasks, depending on `effect-browser` and `effect-browserbase`.
- `tools/`: the pinned-toolchain installer. Releases are `.github/workflows/publish.yml`; see
  `docs/RELEASING.md`.
