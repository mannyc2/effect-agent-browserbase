# Releasing the canonical two-package set

Publication is not performed by ordinary CI. This workflow prepares two independently published Browserbase packages from the pinned upstream integration workspace; it does **not** publish the rest of the Effect Agent monorepo.

The canonical names are `@effect-agent/browserbase` and `@effect-agent/platform-browserbase`. Confirm control and configure trusted publishing for **both** names before enabling publication. This repository does not establish npm ownership, register a package, rename the scope or perform a first-release account bootstrap on your behalf.

## Configure npm trusted publishing

In each package's npm settings, configure the following exact identity:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mannyc2` |
| Repository | `effect-agent-browserbase` |
| Workflow filename | `publish.yml` (not the full path) |
| Environment | `npm` |
| Allowed action | Direct `npm publish` |

New npm trusted-publisher configurations default to staged publishing. This workflow uses direct `npm publish`, so explicitly allow that action; `npm stage publish` approval is a different flow, not something this workflow silently substitutes. npm configuration is not validated when saved—successful OIDC authentication remains unverified until an authorized publish occurs.

Use a GitHub-hosted runner. This workflow pins Node 24.14.1 and checks its npm 11.11.0, above npm's documented minimum of Node 22.14.0 / npm 11.5.1. The emitted package's repository metadata matches this repository, which is required for npm's repository/OIDC checks.

Create and protect the GitHub environment **npm** with an approval rule and version-tag restrictions (`v*`). Protect release tags against unauthorized creation or reassignment. Do not store an npm publish token: the publish job requests a short-lived OIDC credential. No repository/environment settings are created by this source change.

Leave repository variable **NPM_PUBLISH_ENABLED** unset until the configuration and intended package identity are reviewed. Only then set it to the literal string `true`. After verifying trusted publishing, restrict traditional token publishing and revoke obsolete automation tokens in npm settings.

Official references: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use).

## Prepare a release

Update both coordinated package versions and the relevant integration lockfile/changeset entries in one PR. Keep the accepted Effect/AgentRuntime/Playwright compatibility pins unless the PR is explicitly upgrading them. The upstream fixed release-train invariants are still enforced; standalone versioning is not introduced by this maintenance change.

After that PR is merged and acceptance passes, create an immutable `v<package-version>` tag on its commit. This document describes the maintainer release procedure; neither creating a tag nor publishing is part of automated maintenance work.

Run **npm release** manually on that **tag**, with `publish` left **false** first. Branch dispatches, tags not reachable from `main`, and tags that do not exactly match the package version are rejected. Tag-scoped execution also ensures provenance refers to the released source commit rather than an unrelated current `main` commit.

The workflow checks fresh full acceptance through `ci.yml`. It builds both packages, packs each once, verifies the exact archives in three clean consumers, and performs `npm publish --dry-run --ignore-scripts` for each archive. Resources-only, generic-native, and actual AgentRuntime consumers run on the pinned Node and Bun versions; all public declarations and migrated examples are checked with `skipLibCheck:false`. There is no legacy consumer or compatibility export fallback. It retains the receipt, source, logs, decoded video and SHA-256 checksums. A dry-run does not validate npm OIDC configuration or claim publication.

## Publish deliberately

Run the same workflow on the same immutable tag with `publish=true` after enabling `NPM_PUBLISH_ENABLED`. Acceptance is run again; the protected `npm` environment then gates the only job with `id-token: write`.

That job downloads the exact immutable artifact ID returned by its own successful build, verifies the source commit, coordinated versions, package identities and both archives against the **release-set receipt SHA-256** returned by the successful build. Each member carries a SHA-256 digest and SHA-512 integrity; the verifier inspects both archives without extracting or executing their contents. A missing, reordered, mixed-source, mixed-version or corrupted member rejects the entire set before publication. It runs no dependency install, build or package lifecycle script. `npm publish` receives only each already-tested tarball, with public access and provenance, **generic before adapter**. The adapter's exact generic dependency is never rewritten to a local path in the tarball. Only private verification consumers use a file-tarball override and prove that the root and adapter resolve the same generic installation.

`alpha.N`, `beta.N` and `rc.N` versions use their corresponding dist-tag; a stable `x.y.z` release uses `latest`. A prerelease can never fall through to `latest`. This is an ESM distribution with `.d.mts` declarations; it does not claim CommonJS support.

The workflow has no GitHub contents-write permission. It does not bump versions, commit formatting, push tags, create GitHub releases, provision services, deploy documentation or allocate Browserbase sessions. There is no atomic two-package registry transaction and no automatic retry after an ambiguous publication. On a deliberately authorized rerun, `tools/publish-release.mjs` reads the exact registry version's `dist.integrity`: an identical already-published member is retained, an absent member is published, and a differing integrity stops recovery. Only a structured registry `E404` means absent; a network/authentication failure does not. Per-member outcomes are retained in `publication.ndjson`, so a later failure does not erase earlier facts. Never move the tag or overwrite a published version to fix it; publish a reviewed new version.

## Package contents and evidence

`tools/packages.mjs` inventories exactly the generic package and the adapter in dependency order. Source manifests own their explicit export maps; the adapter is restricted to `.`, `./adapter`, and `./tools`. The generic package has no framework dependency and its declarations cannot import Playwright or an undeclared SDK.

`tools/package-release.mjs` is the single staging path. It produces two dist-only archives and **`release-set.json` (schema version 2)**, with one source SHA, coordinated package version, framework version, release channel, and both member identities/hashes. No old `release.json` reader or success fallback remains. Staging refuses existing output or partial-set reuse; an incomplete packing attempt never writes a success receipt. Preserve failed output for diagnosis, then use a fresh output directory.

`tools/verify-release.mjs` checks the whole source-bound set. `tools/publish-release.mjs` is its dependency-free dry-run/authorized-publication caller. Both remain host-only repository tooling; the OIDC job installs no dependencies and executes no package lifecycle scripts. `tools/packed-consumers.mjs` stages only approved test/example dependency closures, never production source or workspace aliases, and verifies installed member bytes against their candidate archives.

The upstream `release:publish --dry-run` remains an integration check only. Do **not** run its non-dry-run form from this repository: that command owns the upstream multi-package release train, not this repository's two-package publisher.
