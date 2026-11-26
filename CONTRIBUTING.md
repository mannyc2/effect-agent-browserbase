# Contributing

Open a focused PR against `main` that explains the change and how it was checked. CI runs
`bun run ready` on every PR.

## Toolchain

| Input                | Pin                           |
| -------------------- | ----------------------------- |
| Node                 | 24.14.1 (`.node-version`)     |
| Bun                  | 1.4.2                         |
| Effect               | 4.1.2                         |
| Playwright           | playwright-core 1.63.0        |
| Yielded Agent        | @yielded/agent 0.1.0-beta.191 |
| TypeScript / Vite+   | 7.0.2 / 1.1.0                 |
| Vitest               | 5.0.3, as Vite+ 1.1.0 ships   |
| Effect tsgo / Oxlint | 0.51.0 / 1.82.0               |

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

- A plain `bun install` runs `patch:tsgo` itself, as the repository's `postinstall`; an install
  with `--ignore-scripts`, as CI's is, runs no script, so run it after.
- `bun run fmt` formats. `oxlint -c lint/.oxlintrc.json --fix <files>` fixes the stylistic rules
  that `fmt` leaves alone. Fix a lint finding or Effect diagnostic rather than suppress it.
- Read `node_modules/effect/AGENTS.md` before writing Effect code.
- Tag what a package exports as Effect does: each public export's doc carries `@stability`,
  `@category` and `@since` (the release that adds it), and a public module's opening doc
  `@stability` and `@since`. Lint checks it; `lint/plugins/tags.ts` lists the categories. `Film` is
  `experimental`, the rest `stable`.
- Tests live in each package's `test/` and run against a real local Chromium with pages served by
  the test itself. Scripted models stand in for real ones: no test calls a model or a hosted browser.
- The bench (`bench/`) is the place for evidence about models; its README says how to run it.

## Keeping it small

- **Size.** A module holds at most 600 lines of code and a function at most 150, falling to 100;
  lint counts code only. The exceptions in `lint/.oxlintrc.json` sit at each file's size when the
  limits came in. Lower one when a change shrinks its file, and never raise one.
- **Exceptions say why.** A comment that switches a check off gives its reason after `--`, as
  in `// oxlint-disable-next-line <rule> -- <why this site is an exception>`. Lint enforces it.
- **A PR says what it deletes,** the source and test lines it adds and removes, the public names
  it adds and removes, and any check it adds or exception it lowers. A PR that only adds says
  why. `git diff --shortstat origin/main -- 'packages/*/src/*'` counts source lines, and
  `'packages/*/test/*'` test lines.
- **Tests earn their place.** A rule over many inputs gets a property test (`it.prop` with
  `effect/Arbitrary`); anything with history gets a model test. Before trusting a new test, plant
  the bug it guards against and watch it fail. Don't pin wording, such as a prompt's exact text.

## Layout

- `packages/browser` (`effect-browser`): the browser, pages, snapshots, frames, events and moments,
  and an agent's browser tools. It depends on `effect` and `playwright-core` only. Public kernel
  modules live in `src/`, each at its own path; the root exports all but `Cdp` and `Site`. Each
  optional feature is a folder (`timeline`, `presentation`, `walk`, `policy`, `supervisor`,
  `testing`, `ai`) whose `index.ts` is its
  public subpath; a feature's own `internal/` is closed. `src/internal/`, also closed, groups
  kernel implementation by CDP connection, page, pictures, input, reading and timeline.
  `bun run boundaries` checks dependency direction and that the root loads only `effect`, then
  physically deletes each feature folder with the features that import it, and then all of them,
  before typechecking what remains. Features use public kernel modules and a short list of shared
  internals; published test services also share an explicit five-module allowlist. Code
  inside the page sits in self-contained `*.inpage.ts` factories, composed by
  `internal/page/bridge.ts` and frozen at packaging.
- `packages/chromium` (`@effect-browser/chromium`): a local Chromium as a `Browser`, launched
  through `playwright-core`. It depends on `effect-browser` through its public entry points.
- `packages/browserbase` (`@effect-browser/browserbase`): the Browserbase client and sessions as a
  `Browser`. It depends on `effect-browser` through its public entry points.
- `packages/yielded` (`@effect-browser/yielded`): `effect-browser/ai`'s tools for a Yielded agent's
  run, which also show the model the page, or its moments, as the run's context. It depends on
  `effect-browser` through its public entry points and on `@yielded/agent`, pinned exactly; it is
  the only package that depends on Yielded.
- `packages/human-strokes` (`@effect-browser/human-strokes`): an optional pointer planner over
  recorded human strokes. It depends on `effect-browser` through its public entry points only. Its
  code is MIT; its bundled stroke data is CC BY 4.0, with attribution in its README and
  `LICENSE-data`.
- `packages/tradingview` (`@effect-browser/tradingview`): TradingView charts' data, screen points
  and changes, and an agent's tools for them. It depends on `effect-browser` through its public
  entry points.
- `bench`: private graded tasks, depending on `effect-browser`, `@effect-browser/chromium`,
  `@effect-browser/browserbase`, `@effect-browser/yielded` and `@effect-browser/tradingview`, whose
  agents run on Yielded.
- `tools/`: the pinned-toolchain installer, `check-packed.sh`, which checks the packed
  packages in a clean consumer, and shared repository-only test support in `tools/testing/`: a CDP
  proxy and the agent tests' pages.
  Package test cases stay in their package; shared support does not import package-private code. Releases are `.github/workflows/publish.yml`; see
  `docs/RELEASING.md`.
