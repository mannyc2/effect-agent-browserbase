# Browserbase platform for Effect Agent

Use the existing `InteractiveBrowser` service on a trusted Node or Bun host.
The host owns one browser for the enclosing execution; Tools borrow its handle.
The `recordings`, `replays`, and `downloads` entry points work independently of
live browser scopes. `capture` borrows the same remote page without owning an
encoder or filesystem.

This package is an unpublished maintainer-review candidate. Hosted Browserbase
acceptance is separately gated and has not been executed. No release, deployment,
or paid model invocation is performed by its tests.

See the repository [browser guide](../../docs/guide/browser.md) and the public
examples in `examples/`. Development commands use Vite+: `vp run check`, `vp test`,
`vp run install:test-browser`, `vp run test:native`, and `vp pack`. Native tests
require Playwright 1.63.0's Chromium and run against loopback HTTP fixtures over
CDP. Unit tests use the official Effect TestClock and scripted provider edges.
