# Security

## Reporting

Do not put credentials, signed media URLs, private page content or a working exploit against someone else's session in a public issue. Use this repository's **Security → Report a vulnerability** facility when enabled. If private reporting is unavailable, open a minimal issue requesting a private contact without including vulnerability details. Private reporting must be enabled by a maintainer in repository settings; this file does not enable it.

## Supported boundary

This is a prerelease trusted-host integration, not a multi-tenant browser isolation service. The currently verified toolchain is documented in [CONTRIBUTING.md](CONTRIBUTING.md). Hosted Browserbase guarantees have not been validated by local CI, and untested engine/peer versions are not implicitly supported.

Only trusted-host `Unrestricted` network policy is supported. `ExactHosts` and `PublicWeb` fail before allocation. A browser must not use ambient application credentials, URLs, filesystem paths or network authority supplied by an untrusted model. A supplied host fetch implementation is trusted code, not a sandbox boundary.

Keep Browserbase API keys, CDP connection URLs, Live View URLs and signed artifact URLs out of model inputs, logs and durable records. Human takeover/release is an application authorization decision; displaying an iframe is not authorization. Persistent browser-context writers require an exclusive application-owned lease.

An action with an unknown outcome must not be replayed automatically. Local disconnect and accepted release are not proof of remote termination. Live capture supplies frames only, not website audio or proof that the provider captured every frame.

## Supply chain

PR CI has read-only GitHub permissions and does not receive hosted/model credentials. Actions are pinned by commit and dependency installation is frozen. Package output is allowlisted and checked in an external consumer. Published artifacts contain emitted runtime/declarations, README and license—not fixtures, recovery tools, credentials or lifecycle scripts.

The optional hosted Browserbase workflow is manual, default-off and gated on a protected environment holding the only paid credentials in this repository. It has no `pull_request`, `pull_request_target` or `schedule` trigger, so provider credentials never reach unreviewed code, and ordinary PR CI remains unable to allocate a session. Rotate a Browserbase key that has been exposed outside GitHub's secret store. See [hosted runs](docs/HOSTED.md).

The optional npm workflow is manual, tag-scoped, default-off and uses a separate OIDC job. Configure the protected `npm` environment and trusted publisher before enabling it. Build/test jobs receive no OIDC permission; the publishing job installs no dependencies and executes no package lifecycle scripts. Package identity, source commit and tarball digest are checked again before publication. See [RELEASING.md](docs/RELEASING.md).
