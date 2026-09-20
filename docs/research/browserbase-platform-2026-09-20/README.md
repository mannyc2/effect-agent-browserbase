# Browserbase platform and integration architecture review

Research date: 2026-09-20. Baseline: [`1b3e9b1916621d036f2568c821e83bed72400f9c`](https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c).

This is a documentation-only investigation explicitly requested by the maintainer, including a proposed design and implementation plan. It does not change the current public contract, authorize paid sessions, or supersede accepted architecture decisions without a subsequent implementation review. In particular, the existing no-raw-CDP boundary remains in force.

## Research scope

Evaluate Browserbase browser infrastructure and browser operation from complete consumer workflows, not a list of type fields. Start with the [official documentation index](https://docs.browserbase.com/llms.txt), current API and SDK source, examples, and release history. Independent inference, search/fetch products, autonomous agent products, and hosted application deployment are not proposed as dependencies of this integration.

Trace persistent Contexts, browser creation settings, extensions, connection ownership, state persistence, customization readiness, pages/frames, authentication, network controls, files, live viewing, and artifacts through the public API into actual provider calls and native behavior. Distinguish provider promises, source findings, historical test evidence, fresh experiments, and proposals.

## Verified starting points

- The package owns an Effect HTTP integration; `packages/platform-browserbase/package.json` does **not** declare `@browserbasehq/sdk`. A comparison described as upgrading an installed Browserbase SDK would therefore be misleading. The maintained native automation dependency is optional-peer `playwright-core@1.63.0`.
- Coordinated acceptance pins are Effect `4.0.0-rc.115`, effect-agent/testing `0.1.0-beta.102`, TypeScript `7.0.2`, Vite+ `0.3.2`, Node `24.14.1`, Bun `1.4.2`, and upstream `danieljvdm/effect-agent@ea53ea6671a94eb44b8019e942cc2c9468786723`. These are not inferred from earlier conversations.
- Existing public functionality already includes `{ context: { id, persist }, contextLease }`, two-phase acquisition, keep-alive detach/reconnect, page/frame selection, handoff, independent recordings/replays/downloads, and target-pinned live capture. They require tracing rather than being classified as absent.
- The current package explicitly rejects `ExactHosts` and `PublicWeb`, keeps native SDK objects private, distinguishes unknown mutation outcomes, and serializes owned mutations. The target design must preserve the reasons for these boundaries rather than expose an unguarded second browser connection.

Sources: [contributing/toolchain](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/CONTRIBUTING.md), [package manifest](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json), [public host implementation](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/InteractiveBrowser.ts), [package guide](https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/README.md).

## Evidence boundary

The GitHub connector can read source and commit new documentation. A fresh sandbox clone failed with `Could not resolve host: github.com`; consequently there is not yet a bootstrapped local checkout or a fresh native/Effect acceptance result from this research session. Remote source inspection is not described as executing the package. No production credentials, paid Browserbase sessions, model calls, deployments, or publishing are used.

This initial commit preserves the baseline and research scope. Subsequent commits on this branch add the platform research, capability map, proposed architecture, workflows, implementation stages, and final evidence ledger. Only completed, committed sections should be treated as delivered research.
