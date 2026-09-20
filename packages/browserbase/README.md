# Browserbase for Effect

`@effect-agent/browserbase` owns Browserbase resource identity, one immutable account Client, launch configuration and scoped resource ownership. It has no Effect Agent dependency. Playwright is an optional peer for the native browser implementation; control-plane services never load it.

## Control plane

Construct `BrowserbaseClient.layer(account)` once and provide it to `BrowserbaseSessions.layer` and `BrowserbaseContexts.layer`. `sessions.retrieve`, `list`, `waitUntilRunning` and `waitForTerminal` are passive. `sessions.requestRelease` is an explicit remote mutation. Context create/retrieve/delete are separate resource operations; deleting a Context is never a browser finalizer.

`ContextCoordination.withWriter` accepts a consumer-owned distributed lease backend and preserves the consumer's Effect error/environment types. Persisting allocations authenticate that live permit and report their exact attempt, session and cleanup receipt before settlement. Unknown writers and unconfirmed persistence are quarantined. A terminal session does not establish that Context data has finished synchronizing.

## Implementation status

This is an in-progress hard cutover. The canonical control plane, writer coordination, allocation and ordered cleanup are implemented. Native browser/adapter/consumer and release-set integration remain unfinished. No legacy facade is part of the target API. Repository acceptance must include this package before any generic validation claim is made.

Read the source research under `docs/research/browserbase-platform-2026-09-20/` with the maintainer's hard-cutover override: compatibility constructors, legacy exports, migration windows and a fourth legacy consumer are not implementation obligations.
