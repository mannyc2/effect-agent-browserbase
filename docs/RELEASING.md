# Releasing

`effect-browser`, `effect-browserbase`, `effect-browser-human-strokes` and `effect-agent-browser`
are released together, at one version, by `.github/workflows/publish.yml`. The workflow runs on a
`v<version>` tag on `main`, runs `bun run ready`, packs the four packages, checks the archives in a clean consumer and
publishes them through npm trusted publishing: no npm token, and npm signs provenance for each
package. Ordinary CI never publishes,
and preparing or testing a release does not authorize publishing, tagging or changing account
settings.

An unreleased cutover may use a commit-pinned upstream archive through the repository's
`@yielded/agent` override. It can merge after CI passes, but the publish workflow rejects that
override before building, including in a dry run: npm consumers do not inherit workspace
overrides. Before a release, remove the override once the required version is on npm, refresh
`bun.lock`, and verify the actual npm dependency with CI and the clean-consumer check.

## One-time setup

The owner does this once, in npm and GitHub settings.

1. **Reserve the names.** npm can only trust a publisher for a name that exists, so each name is
   published by hand once as a placeholder, `0.0.0-reserved.0`. `effect-browser`,
   `effect-browser-human-strokes` and `effect-agent-browser` are done. npm points `latest` at a
   name's first version, so `latest` stays on the placeholder until a stable release.

2. **Trust the workflow on npm.** For each of the four packages, open the package's
   **Settings → Trusted publishing** on npmjs.com, choose **GitHub Actions** and enter:

   | Field                | Value                      |
   | -------------------- | -------------------------- |
   | Organization or user | `mannyc2`                  |
   | Repository           | `effect-agent-browserbase` |
   | Workflow filename    | `publish.yml`              |
   | Environment name     | `npm`                      |
   | Allowed actions      | `npm publish`              |

   The workflow publishes with `npm publish`, so tick it under allowed actions: an entry created
   after 3 September 2026 allows only `npm stage publish` until you do. `effect-browser`,
   `effect-browserbase` and `effect-agent-browser` were published by this workflow file in 0.2, so
   they should already have this entry; check that it matches. npm does not test the entry when
   it is saved, so the first release is the test.

3. **Protect the `npm` environment.** In the repository's **Settings → Environments**, the `npm`
   environment (it exists from 0.2) should have the owner as a required reviewer, and its
   deployment branches and tags limited to the tag pattern `v*`. Only the publish job uses it, so
   a dry run is never held for approval.

4. **Clean up after the first release.** Once a release has gone through, set each package's
   **Publishing access** to "Require two-factor authentication and disallow tokens", and revoke
   any npm automation tokens. The repository variable `NPM_PUBLISH_ENABLED` is no longer read and
   can be deleted.

## Peer ranges

- **`effect` is `~4.0.0` in every package:** 4.0's patch releases, and never 4.1. The packages are
  built on modules that Effect 4 marks `@stability unstable`: `effect/ai`, `effect/http` and
  `effect/observability`. Semver does not hold those, and a minor release may change them. A caret
  range would let a consumer install an Effect the packages were never checked against.
  - Widen the range to the next minor in the release that is checked against it.
  - Widen it to `^4.0.0` once those modules are stable.
- **`effect-browser`** is a caret range in the other three packages, from the version each needs.
  Move it in the release that needs a newer one.
- **`@yielded/agent`** is one exact version in `effect-agent-browser`, because each Yielded beta may
  change the ports that `effect-agent-browser` implements. Its README's install line names that
  version. It becomes a caret range once Yielded Agent leaves beta.
- **`playwright-core`** is `^1.63.0`.

## Cut a release

1. In one PR, set the same `version` in all four `packages/*/package.json`, add the release's
   section to `CHANGELOG.md`, move the `effect-browser` peer ranges in `effect-browserbase`,
   `effect-browser-human-strokes` and `effect-agent-browser` if the release needs the new version, and run
   `bun install --ignore-scripts` so `bun.lock` agrees. 0.3's first release also deletes the root
   README's note that 0.3 is not on npm.
2. Once it is merged, tag the merge commit and push the tag:

   ```sh
   git fetch origin
   git tag v0.3.0-beta.0 origin/main
   git push origin v0.3.0-beta.0
   ```

3. Dry run, then publish:

   ```sh
   gh workflow run publish.yml --ref v0.3.0-beta.0
   gh workflow run publish.yml --ref v0.3.0-beta.0 -f dry-run=false
   ```

   The dry run checks the tag, runs `bun run ready`, packs, checks the archives in a clean
   consumer, and runs `npm publish --dry-run` on each archive. With `dry-run=false` the publish job then waits for approval in the `npm`
   environment and publishes the archives the build job checked.

The clean-consumer check is `tools/check-packed.sh`. It installs the archives outside the
repository, with the peers npm picks for their ranges, and has TypeScript check every entry point's
declarations with `skipLibCheck: false` and Node import each one: `bun run ready` cannot see a
declaration or an import that only the workspace satisfies. CI runs it on every PR, after `ready`;
run it before tagging too: without arguments it builds and packs the packages itself, under
`$TMPDIR`.

The tag must be on `main` and name the version all four packages carry. A prerelease
`x.y.z-alpha.N`, `-beta.N` or `-rc.N` goes to the dist-tag of that name; only a plain `x.y.z` goes
to `latest`. Packages publish in dependency order, and a version already on npm is skipped, so
dispatching the same tag again finishes an interrupted release. A published version cannot be
replaced; fix a bad one with a new version.

## History

0.2 was released by a different path: `tools/release`, built on ts-release, which staged the
archives in five packed consumers and kept recovery records on the `ts-release-prepared/*` and
`ts-release-journal/*` branches. Keep those branches. It published `effect-browser`,
`effect-browserbase` and `effect-agent-browser` from `0.2.0-beta.0` to `0.2.0-beta.9`, the last
from tag `v0.2.0-beta.9` (`976d316`). Before that, `effect-browserbase` and
`effect-agent-browserbase` ended at `0.1.0-beta.104`. The code is in Git history at `1ed8259`.
