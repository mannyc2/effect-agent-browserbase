# Browser package release tooling

This private package prepares and publishes the coordinated `effect-browser`,
`effect-browserbase` and `effect-agent-browser` release. It uses the pinned
`@mannyc1/ts-release` and npm provider to retain publication intent, verify registry
observations and prevent an uncertain upload from being replayed.

The release receipt remains schema version 2. It requires all three archives in
that order, one shared package version, the exact source commit and the existing
archive digests. The framework version is recorded separately; `effect-agent`
is a dependency of the adapter and is never a member of this release set.

`effect-browserbase` and `effect-agent-browser` both depend on `effect-browser`.
The release plan additionally serializes the complete set: browser, provider,
then adapter. All three provenance attestations must be admitted before the
first upload. An uncertain upload blocks its dependents until an exact registry
observation establishes its outcome. A missing version does not authorize replay.

Prepared state retains at most nine files: Bundle, Plan, receipt, three archives
and three provenance bundles. Content is addressed by digest, bounded to 128 MiB
per file and 512 MiB in total, and checked again when restored from the Git state
branch. Credentials are supplied for the current operation and are not part of
the retained preparation or journal.

## Local verification

Use the repository's pinned Bun 1.4.2. This isolated tooling package uses its own
frozen lockfile and is separate from the Vite+ framework verification workspace.
Run from `tools/release`:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test
bun run build
node scripts/pack.mjs ../../.work/release-tooling
```

The pack step restores the archive and checks its relocated application imports
and native CLI. It does not publish. Tests exercise three-member preparation,
signature admission, byte identity, dependency ordering, Git restoration and
uncertain-upload recovery with offline transport fixtures.

Live publication belongs to the opt-in GitHub workflow in
[`publish.yml`](../../.github/workflows/publish.yml). Its privileged job consumes
the already tested archive and makes no dependency installation. See
[`docs/RELEASING.md`](../../docs/RELEASING.md) for the repository release procedure.
