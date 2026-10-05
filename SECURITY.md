# Security

## Reporting

Do not put credentials, signed media URLs, private page content or a working exploit against someone else's session in a public issue. Use this repository's **Security → Report a vulnerability** facility when enabled. If private reporting is unavailable, open a minimal issue requesting a private contact without including vulnerability details. Private reporting must be enabled by a maintainer in repository settings; this file does not enable it.

## Boundary

effect-browser drives a browser for a trusted host. It is not a sandbox: an agent's browser goes wherever the model sends it, with whatever its context holds, such as cookies and signed-in sessions. Give an agent a fresh context, or a Browserbase session, with only the authority its task needs, and use `Browser.Options.guard` to refuse input a task must never make.

The tools never give a model the Playwright page, a connect URL or a credential. A failure after input reached the page says so (`BrowserError.dispatched`), and the agent is told to look before repeating the action; nothing is replayed automatically.

Keep Browserbase API keys, connect URLs and Live View URLs out of model inputs, logs and durable records. The client sends the key only in the `x-bb-api-key` header, marks that header redacted, and refuses redirects so the key never follows one.

## Supply chain

CI has read-only permissions and no hosted or model credentials. Actions are pinned by commit, and installs are frozen to the committed `bun.lock` with lifecycle scripts disabled. The published packages contain their built output, source, README and license.

The npm workflow is manual, tag-scoped and default-off, with a separate OIDC job; see [RELEASING.md](docs/RELEASING.md).
