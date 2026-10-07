# Releasing

`effect-browser`, `effect-browserbase` and `effect-browser-human-strokes` are released together,
at one version, by `.github/workflows/publish.yml`. The workflow runs on a `v<version>` tag on
`main`, runs `bun run ready`, packs the three packages and publishes them through npm trusted
publishing: no npm token, and npm signs provenance for each package. Ordinary CI never publishes,
and preparing or testing a release does not authorize publishing, tagging or changing account
settings.

## One-time setup

The owner does this once, in npm and GitHub settings.

1. **Reserve `effect-browser-human-strokes`.** Done: npm can only trust a publisher for a name
   that exists, so the name was published by hand as a placeholder, `0.0.0-reserved.0`, like
   `effect-browser`'s. npm points `latest` at a name's first version, so `latest` stays on the
   placeholder until a stable release.

2. **Trust the workflow on npm.** For each of the three packages, open the package's
   **Settings → Trusted publishing** on npmjs.com, choose **GitHub Actions** and enter:

   | Field                | Value                      |
   | -------------------- | -------------------------- |
   | Organization or user | `mannyc2`                  |
   | Repository           | `effect-agent-browserbase` |
   | Workflow filename    | `publish.yml`              |
   | Environment name     | `npm`                      |
   | Allowed actions      | `npm publish`              |

   The workflow publishes with `npm publish`, so tick it under allowed actions: an entry created
   after 3 September 2026 allows only `npm stage publish` until you do. `effect-browser` and
   `effect-browserbase` were published by this workflow file in 0.2, so they should already have
   this entry; check that it matches. npm does not test the entry when it is saved, so the first
   release is the test.

3. **Protect the `npm` environment.** In the repository's **Settings → Environments**, the `npm`
   environment (it exists from 0.2) should have the owner as a required reviewer, and its
   deployment branches and tags limited to the tag pattern `v*`. Only the publish job uses it, so
   a dry run is never held for approval.

4. **Clean up after the first release.** Once a release has gone through, set each package's
   **Publishing access** to "Require two-factor authentication and disallow tokens", and revoke
   any npm automation tokens. The repository variable `NPM_PUBLISH_ENABLED` is no longer read and
   can be deleted.

## Cut a release

1. In one PR, set the same `version` in all three `packages/*/package.json`, add the release's
   section to `CHANGELOG.md`, move the `effect-browser` peer ranges in `effect-browserbase` and
   `effect-browser-human-strokes` if the release needs the new version, and run
   `bun install --ignore-scripts` so `bun.lock` agrees.
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

   The dry run checks the tag, runs `bun run ready`, packs, and runs `npm publish --dry-run` on
   each archive. With `dry-run=false` the publish job then waits for approval in the `npm`
   environment and publishes the archives the build job checked.

The tag must be on `main` and name the version all three packages carry. A prerelease
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
