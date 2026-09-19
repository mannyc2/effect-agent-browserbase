# Releasing this package

Publication is not performed by ordinary CI. This workflow prepares an independently published Browserbase package from the pinned upstream integration workspace; it does **not** publish the rest of the Effect Agent monorepo.

The current npm name is `@effect-agent/platform-browserbase`. Confirm that you control that package/scope before enabling publication. This repository does not establish npm ownership, register a package, rename the scope or perform a first-release account bootstrap on your behalf.

## Configure npm trusted publishing

On the package's npm settings, configure the following exact identity:

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

Update the package version and relevant integration lockfile/changeset entries in a PR. Keep the accepted Effect/AgentRuntime/Playwright compatibility pins unless the PR is explicitly upgrading them. The upstream fixed release-train invariants are still enforced; standalone versioning is not introduced by this maintenance change.

After that PR is merged and acceptance passes, create an immutable `v<package-version>` tag on its commit. This document describes the maintainer release procedure; neither creating a tag nor publishing is part of automated maintenance work.

Run **npm release** manually on that **tag**, with `publish` left **false** first. Branch dispatches, tags not reachable from `main`, and tags that do not exactly match the package version are rejected. Tag-scoped execution also ensures provenance refers to the released source commit rather than an unrelated current `main` commit.

The workflow checks fresh full acceptance through `ci.yml`. It builds the package once for the release artifact, tests that exact tarball in the external consumer, and performs `npm publish --dry-run --ignore-scripts`. It retains the receipt, source, logs, decoded video and SHA-256 checksums. A dry-run does not validate npm OIDC configuration or claim publication.

## Publish deliberately

Run the same workflow on the same immutable tag with `publish=true` after enabling `NPM_PUBLISH_ENABLED`. Acceptance is run again; the protected `npm` environment then gates the only job with `id-token: write`.

That job downloads the exact immutable artifact ID returned by its own successful build, verifies the source commit, version, package name, repository and SHA-256 against the build output, and inspects the tarball without executing its contents. It runs no dependency install, build or package lifecycle script. `npm publish` receives only the already-tested tarball, with public access and provenance.

`alpha.N`, `beta.N` and `rc.N` versions use their corresponding dist-tag; a stable `x.y.z` release uses `latest`. A prerelease can never fall through to `latest`. This is an ESM distribution with `.d.mts` declarations; it does not claim CommonJS support.

The workflow has no GitHub contents-write permission. It does not bump versions, commit formatting, push tags, create GitHub releases, provision services, deploy documentation or allocate Browserbase sessions. No automatic retries attempt a second publication after an ambiguous registry result: inspect the registry before deliberately retrying. Never move the tag or overwrite a published version to fix it; publish a reviewed new version.

## Package contents and evidence

`tools/package-release.mjs` is the single staging path for external-consumer verification and publication. It emits only `dist`, README, license and a normalized manifest; resolves the actual pinned framework dependency; and refuses missing declarations, unexpected export paths, symlinks, private packages and unresolved development specifiers. `tools/verify-release.mjs` is a dependency-free verifier for the privileged job.

The upstream `release:publish --dry-run` remains a compatibility check only. Do **not** run its non-dry-run form from this repository: that command owns the upstream multi-package release train, not this package's independent publisher.
