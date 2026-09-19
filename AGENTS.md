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

`checkpoints/` is immutable provenance. Do not edit it or use it to reconstruct current source. Old transfer instructions and session logs are historical, not active operating instructions. Keep rationale and current results in PRs rather than adding planning documents or committed transient logs.

## Safety and release

Ordinary CI remains read-only, without `pull_request_target`, auto-writing formatters, hosted browser/model credentials or publication. No hosted Browserbase session, paid inference, deployment, service provisioning or npm publication is authorized merely by a maintenance request.

`docs/RELEASING.md` describes a separately enabled, tag-scoped npm OIDC workflow. Preparing or testing it does not authorize running its publishing job, registering a package, changing account permissions, or creating release tags. Preserve commit/checkpoint history; use normal commits, never force-push or rewrite accepted history.
