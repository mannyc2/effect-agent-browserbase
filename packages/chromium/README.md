# @effect-browser/chromium

A local Chromium for [effect-browser](../browser), launched through `playwright-core` for a scope
and closed with it, as a `Browser` layer.

```sh
npm install @effect-browser/chromium@beta effect-browser@beta effect playwright-core
npx playwright-core install chromium
```

```ts
import * as Chromium from "@effect-browser/chromium/Chromium";

const browser = Chromium.layer({ viewport: { width: 1280, height: 720 } });
```

`Chromium.open` and `Chromium.layer` take `effect-browser`'s `Browser.Options` and the launch's own:
`headless` (default true), `sandbox`, `viewport`, `deviceScaleFactor`, `executablePath`, `args`,
`userAgent` and `locale`. It uses the Chromium build that `playwright-core` installs unless
`executablePath` names another.

`Chromium.layer` launches that Chromium without its sandbox, as Playwright does, so an exploit in a
page's renderer runs with your user's privileges. `Chromium.layer({ sandbox: true })` runs it
sandboxed. Hosts that don't allow unprivileged user namespaces, such as many containers and Ubuntu
23.10 or later by default, can't start the sandbox; opening then fails and says so.

`Chromium.layer` leaves signals to your program: Playwright's own handlers, which close every
browser and, on SIGINT, exit before any finalizer runs, are off. Run the program with
`NodeRuntime.runMain` from `@effect/platform-node`, which interrupts it on SIGINT and SIGTERM, so
the browser closes with its scope. A signal that ends the process outright still takes Chromium
with it, since its pipe closes, but leaves Playwright's temporary profile behind.

It reaches effect-browser only through its published entries, and peers on `effect`,
`effect-browser` and `playwright-core`. A remote browser, or one on Workers, is
`effect-browser/Cdp`'s.
