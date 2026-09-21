import { Schema } from "effect";

import { Viewport } from "./BrowserData.ts";
import { ContextReference, ExtensionReference, Identifier } from "./References.ts";

const BoundedString = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const ProxySecret = Schema.Redacted(Schema.String.check(Schema.isMaxLength(8192)));

const Geolocation = Schema.Struct({
  country: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/)),
  state: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/))),
  city: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
});

export const ProxyRule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("browserbase"),
    domainPattern: Schema.optionalKey(BoundedString),
    geolocation: Schema.optionalKey(Geolocation),
  }),
  Schema.Struct({
    type: Schema.Literal("external"),
    server: BoundedString,
    domainPattern: Schema.optionalKey(BoundedString),
    username: Schema.optionalKey(ProxySecret),
    password: Schema.optionalKey(ProxySecret),
  }),
  Schema.Struct({ type: Schema.Literal("none"), domainPattern: Schema.optionalKey(BoundedString) }),
]);

export type ProxyRule = typeof ProxyRule.Type;

/** SDK 2.20 browser subset. Names follow Browserbase; ownership-managed fields are excluded. */
export const ProviderLaunchOptions = Schema.Struct({
  region: Schema.optionalKey(
    Schema.Literals(["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"]),
  ),
  proxies: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Array(ProxyRule).check(Schema.isMaxLength(64))]),
  ),
  proxySettings: Schema.optionalKey(
    Schema.Struct({
      caCertificates: Schema.optionalKey(
        Schema.Array(Identifier).check(Schema.isMaxLength(64), Schema.isUnique()),
      ),
    }),
  ),
  browserSettings: Schema.optionalKey(
    Schema.Struct({
      verified: Schema.optionalKey(Schema.Boolean),
      os: Schema.optionalKey(Schema.Literals(["windows", "mac", "linux", "mobile", "tablet"])),
      allowedDomains: Schema.optionalKey(
        Schema.Array(BoundedString).check(Schema.isMaxLength(64), Schema.isUnique()),
      ),
      blockAds: Schema.optionalKey(Schema.Boolean),
      captchaImageSelector: Schema.optionalKey(BoundedString),
      captchaInputSelector: Schema.optionalKey(BoundedString),
      ignoreCertificateErrors: Schema.optionalKey(Schema.Boolean),
      logSession: Schema.optionalKey(Schema.Boolean),
      recordSession: Schema.optionalKey(Schema.Boolean),
      solveCaptchas: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  userMetadata: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isMaxLength(128)), Schema.Json),
  ),
});

export type ProviderLaunchOptions = typeof ProviderLaunchOptions.Type;

/** Connection behavior and business budgets are not provider session lifetime. */
export const LaunchRecipe = Schema.Struct({
  remoteTimeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 21600 })),
  keepAlive: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(
    Schema.Struct({ reference: ContextReference, persist: Schema.Boolean }),
  ),
  /** Durable project-qualified resource. The compiler alone projects it to provider `extensionId`. */
  extension: Schema.optionalKey(ExtensionReference),
  viewport: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("ProviderManaged") }),
    Schema.Struct({
      _tag: Schema.Literal("Fixed"),
      width: Viewport.fields.width,
      height: Viewport.fields.height,
    }),
  ]),
  provider: ProviderLaunchOptions,
});

export type LaunchRecipe = typeof LaunchRecipe.Type;
