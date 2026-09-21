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

Use a GitHub-hosted runner. The native ts-release host pins Node 22.22.2, supported by ts-release 0.4.0 and its Sigstore dependencies. It exchanges GitHub OIDC identity for a package-scoped npm credential and signs/verifies provenance through the native provider; no npm publish subprocess is involved. The emitted package's repository metadata matches this repository. The library acceptance toolchain remains Node 24.14.1 and Bun 1.4.2.

Create and protect the GitHub environment **npm** with an approval rule and version-tag restrictions (`v*`). Protect release tags against unauthorized creation or reassignment. Do not store an npm publish token: the publish job requests a short-lived OIDC credential. No repository/environment settings are created by this source change.

Leave repository variable **NPM_PUBLISH_ENABLED** unset until the configuration and intended package identity are reviewed. Only then set it to the literal string `true`. After verifying trusted publishing, restrict traditional token publishing and revoke obsolete automation tokens in npm settings.

Official references: [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), and [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use).

## Prepare a release

Update both coordinated package versions and the relevant integration lockfile/changeset entries in one PR. Keep the accepted Effect/AgentRuntime/Playwright compatibility pins unless the PR is explicitly upgrading them. The upstream fixed release-train invariants are still enforced; standalone versioning is not introduced by this maintenance change.

After that PR is merged and acceptance passes, create an immutable `v<package-version>` tag on its commit. This document describes the maintainer release procedure; neither creating a tag nor publishing is part of automated maintenance work.

Run **npm release** manually on that **tag**, with `publish` left **false** first. Branch dispatches, tags not reachable from `main`, and tags that do not exactly match the package version are rejected. Tag-scoped execution also ensures provenance refers to the released source commit rather than an unrelated current `main` commit.

The workflow checks fresh full acceptance through `ci.yml`. It builds both packages, packs each once, verifies the exact archives in three clean consumers, and performs `npm publish --dry-run --ignore-scripts` for each archive. Resources-only, generic-native, and actual AgentRuntime consumers run on the pinned Node and Bun versions; all public declarations and migrated examples are checked with `skipLibCheck:false`. There is no legacy consumer or compatibility export fallback. It retains the receipt, source, logs, decoded video and SHA-256 checksums. A dry-run does not validate npm OIDC configuration or claim publication.

## Publish deliberately

Run the same workflow on the same immutable tag with `publish=true` after enabling `NPM_PUBLISH_ENABLED`. Acceptance and the isolated release-tooling tests run again; the protected `npm` environment then gates the only job with `id-token: write` and `contents: write`. The latter permission is required to retain prepared content and append the release journal in this repository. Configure branch rules to forbid deletion and replacement of `ts-release-prepared/*` and non-fast-forward updates/deletion of `ts-release-journal/*`, while allowing the release workflow to create the former and append the latter. No repository settings are changed by this PR.

That job downloads the exact immutable acceptance and release-tooling artifact IDs returned by its own successful build. The host archive is verified against the build's SHA-256 before extraction; its frozen dependencies were installed with Bun and `--ignore-scripts` in the read-only job. There is no dependency install, build or lifecycle execution in the privileged job.

The application still verifies the successful build's whole **release-set receipt SHA-256**, source commit, coordinated versions, package identities, SHA-256 and SHA-512 of both archives, exports and dependency boundaries. A missing, reordered, mixed-source, mixed-version or corrupted member rejects the set. Native ts-release independently inspects the npm archives and owns the content. It creates GitHub Actions Sigstore provenance for each package, finalizes the Bundle, and authors a native npm Plan with the adapter depending on the generic package. The adapter's exact generic dependency is never rewritten to a local path.

Before any npm upload, the complete prepared set—original archives and receipt, owned content, signed provenance, Bundle, Plan and source metadata—is committed once to `ts-release-prepared/<source-sha>`. Creating that ref is conditional on absence; an existing preparation is restored, never replaced. ts-release's `openGitJournal` stores dispatch and observation history on a deterministic `ts-release-journal/<hash>` branch. Credentials stay in the live host, not the retained files or journal.

`alpha.N`, `beta.N` and `rc.N` versions use their corresponding dist-tag; a stable `x.y.z` release uses `latest`. A prerelease can never fall through to `latest`. This is an ESM distribution with `.d.mts` declarations; it does not claim CommonJS support.

The workflow does not bump versions, push release tags, create GitHub releases, deploy documentation or allocate Browserbase sessions. Its only Git writes are the prepared-state and journal refs. There is no atomic two-package registry transaction.

## Continue an interrupted release

Dispatch the same immutable tag with `publish=true` again. Fresh acceptance still checks the source, but publication restores the **original** prepared bytes and Plan from Git rather than signing or repacking a replacement. A fresh local journal cache reconnects to the same remote history. Exact registry evidence can satisfy a previous upload; a conflicting integrity blocks. After a dispatch starts, an absent version alone cannot authorize a resend. The adapter remains blocked until its generic dependency is satisfied.

The workflow retains `publication-report.json` as an Actions artifact when the engine returns a report. Interruption can prevent a report from being written; the Git journal remains the recovery record. Retain both sets of Git refs indefinitely for releases that may need recovery. Do not delete state, move the version tag, regenerate provenance or use the retired direct publisher to clear uncertainty. Resolve the destination evidence explicitly, or publish a reviewed new version.

The integration tests exercise the actual native npm provider and real Git journal against offline registry responses and local bare remotes, including loss of a publication response and recovery on a fresh runner. They do not claim to exercise this repository's live npm permissions, GitHub OIDC exchange or Sigstore signing. Those supported native paths run only during a separately authorized release.

## Package contents and evidence

`tools/packages.mjs` inventories exactly the generic package and the adapter in dependency order. Source manifests own their explicit export maps; the adapter is restricted to `.`, `./adapter`, and `./tools`. The generic package has no framework dependency and its declarations cannot import Playwright or an undeclared SDK.

`tools/package-release.mjs` is the single staging path. It produces two dist-only archives and **`release-set.json` (schema version 2)**, with one source SHA, coordinated package version, framework version, release channel, and both member identities/hashes. No old `release.json` reader or success fallback remains. Staging refuses existing output or partial-set reuse; an incomplete packing attempt never writes a success receipt. Preserve failed output for diagnosis, then use a fresh output directory.

`tools/verify-release.mjs` checks the whole source-bound set. `tools/publish-release.mjs` remains its dependency-free dry-run caller; it no longer authorizes publication. `tools/release` is the only publisher and pins `@mannyc1/ts-release` and `@mannyc1/ts-release-npm` to 0.4.0 with Effect 4.0.0-rc.115. All remain host-only repository tooling; the OIDC job installs no dependencies and executes no package lifecycle scripts. `tools/packed-consumers.mjs` stages only approved test/example dependency closures, never production source or workspace aliases, and verifies installed member bytes against their candidate archives.

The upstream `release:publish --dry-run` remains an integration check only. Do **not** run its non-dry-run form from this repository: that command owns the upstream multi-package release train, not this repository's two-package publisher.
