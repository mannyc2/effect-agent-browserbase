# Repository maintenance

Read `README.md`, `CONTRIBUTING.md`, the relevant package guide and neighboring tests before editing. This repository owns `packages/platform-browserbase`; the pinned upstream workspace is a compatibility harness, not an invitation to change unrelated applications.

## Contracts

- Preserve Effect `E`/`R`, scoped resource ownership, bounded work and typed outcomes.
- Keep the actual Effect/AgentRuntime/Playwright integration. Do not substitute contracts or native engines to satisfy tests.
- Keep public exports deliberate. Provider credentials and native SDK values are not durable/model-facing values.
- Do not replay unresolved mutations or weaken unsupported network policies.
- Use the coordinated pins in `.node-version`, `package.json`, `upstream.patch` and `CONTRIBUTING.md`. Version upgrades require source review and fresh acceptance.

## Commands and source

`bash tools/bootstrap.sh` creates `.work/upstream/tree` from clean pinned upstream, one integration patch and tracked current package files. Follow that workspace's `AGENTS.md` and `docs/TOOLCHAIN.md`; use Vite+ commands. Read `node_modules/effect/AGENTS.md` completely before writing Effect code.

The repository wrapper uses dependency-free Node maintenance scripts so the OIDC-authorized publishing job installs no third-party code. Test them with `node --test tools/test/*.test.mjs`. They are not public runtime APIs. Do not move host-only packaging machinery into production modules.

Commit the candidate before `bash tools/run-acceptance.sh`; that Ubuntu acceptance command rejects dirty source and reusing an output directory. Read actual command exit records and current Actions results. A saved result is historical evidence, not a new execution. Preserve source-only review patches and keep generated artifacts ignored and in Actions artifacts.

Routine PR feedback uses the explicit `library` profile; it still executes every owned native test against the two candidate tarballs and all three strict Node/Bun consumers. Documentation-only checks, focused library checks and `full` pinned-upstream integration are distinct evidence, never interchangeable passes. Full remains the command default and release prerequisite. Preserve the classifier, raw-exit stage inventory, failure artifacts and `timings.tsv`; see `CONTRIBUTING.md`. Never cache browser installation as though a task result restored its external side effects.

`checkpoints/` is immutable provenance. Do not edit it or use it to reconstruct current source. Old transfer instructions and session logs are historical, not active operating instructions. Keep rationale and current results in PRs rather than adding planning documents or committed transient logs.

## Maintenance sessions

A session often starts on a host whose Node and Bun differ from the pins, where `tools/bootstrap.sh` and `tools/run-acceptance.sh` refuse to run at all. Install the pinned runtimes first with `toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"`. Never relax a version assertion or accept the host's versions instead.

Formatting is decided by the Oxfmt that Vite+ already carries; nothing needs to be fetched separately. Bootstrap, run `vp fmt` in that workspace, and bring the result back. Do not hand-write formatting to satisfy `vp run ready`. Use the frozen workspace as the formatter source of truth rather than guessing whitespace or selecting a separate formatter build.

Run experiments in the bootstrapped workspace. Ordinary CI is the fixed acceptance program, not a scratchpad: do not add a disposable workflow to run an experiment or to back up, restore or delete a branch. Use `git` for normal repository changes rather than full-file contents replacements. When the host cannot reach publishers or GitHub, report the concrete prerequisite failure; do not generalize another host's connectivity or silently change the workflow.

Keep the branch list short. Delete a branch once its work is merged or abandoned, and do not leave a pull request in draft over a formatting-only failure that one `vp fmt` resolves.

## Safety and release

Ordinary CI remains read-only, without `pull_request_target`, auto-writing formatters, hosted browser/model credentials or publication. No hosted Browserbase session, paid inference, deployment, service provisioning or npm publication is authorized merely by a maintenance request.

`docs/RELEASING.md` describes a separately enabled, tag-scoped npm OIDC workflow. Preparing or testing it does not authorize running its publishing job, registering a package, changing account permissions, or creating release tags. Preserve commit/checkpoint history; use normal commits, never force-push or rewrite accepted history.
