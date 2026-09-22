import { Schema } from "effect";

import { Identifier } from "../../References.ts";

/** Identifies this local ownership lifetime, not a Browserbase resource or a reusable endpoint. */
export class LocalReference extends Schema.Class<LocalReference>("LocalBrowserReference")({
  provider: Schema.Literal("local"),
  id: Identifier,
}) {}

export class LocalCleanupIssue extends Schema.Class<LocalCleanupIssue>("LocalBrowserCleanupIssue")({
  step: Schema.Literals([
    "fence",
    "capture",
    "initialization",
    "disconnect",
    "terminate",
    "profile",
  ]),
  reason: Schema.Literals(["timeout", "failed", "interrupted"]),
}) {}

/** Connection teardown and observed process exit are separate facts; no provider status exists. */
export class LocalCleanupResult extends Schema.Class<LocalCleanupResult>(
  "LocalBrowserCleanupResult",
)({
  reference: LocalReference,
  ownership: Schema.Literals(["owned", "borrowed"]),
  connection: Schema.Literals(["closed", "failed", "not-connected", "pending"]),
  process: Schema.Literals(["terminated", "unknown", "not-owned"]),
  issues: Schema.Array(LocalCleanupIssue).check(Schema.isMaxLength(16)),
}) {}

const Text = Schema.NonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^[^\u0000\r\n]+$/u),
);

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

/** Only a concrete loopback WebSocket is admitted: no HTTP discovery redirects or remote DNS. */
export const LocalEndpoint = Text.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "ws:" &&
        ["127.0.0.1", "[::1]"].includes(url.hostname) &&
        Schema.is(Port)(Number(url.port)) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/devtools\/browser\/[A-Za-z0-9_-]+$/u.test(url.pathname)
      );
    } catch {
      return false;
    }
  }),
);

const ProxyServer = Text.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        ["http:", "https:", "socks5:"].includes(url.protocol) &&
        url.hostname.length > 0 &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ["", "/"].includes(url.pathname)
      );
    } catch {
      return false;
    }
  }),
);

/** These arguments belong to the launcher; silently overriding them would change ownership. */
const Argument = Text.check(
  Schema.makeFilter(
    (value) =>
      value.startsWith("--") &&
      !/^--(?:user-data-dir|remote-debugging[^=]*|headless|no-sandbox|disable-setuid-sandbox|single-process|proxy-server|proxy-bypass-list)(?:=|$)/u.test(
        value,
      ),
  ),
);

export const LocalLaunch = Schema.Struct({
  executablePath: Schema.optionalKey(Text),
  headless: Schema.optionalKey(Schema.Boolean),
  /** Enabled by default; a trusted host must explicitly choose a sandbox exception. */
  chromiumSandbox: Schema.optionalKey(Schema.Boolean),
  args: Schema.optionalKey(Schema.Array(Argument).check(Schema.isMaxLength(64))),
  proxy: Schema.optionalKey(
    Schema.Struct({
      server: ProxyServer,
      bypass: Schema.optionalKey(Text),
    }),
  ),
  startupTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  ),
});

export type LocalLaunch = typeof LocalLaunch.Type;
