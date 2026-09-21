/** Reviewed request subset, not a generated SDK or a claim of automatic upstream coverage. */
export const contractSource = {
  repository: "browserbase/sdk-node",
  revision: "fe805b86cd860436eae63a2551b12cf02d708ce1",
  version: "2.20.0",
  resource: "src/resources/sessions/sessions.ts",
} as const;

export const sessionCreateFields = [
  "projectId",
  "timeout",
  "keepAlive",
  "region",
  "proxies",
  "proxySettings",
  "extensionId",
  "browserSettings",
  "userMetadata",
] as const;

export const browserSettingsFields = [
  "verified",
  "os",
  "allowedDomains",
  "blockAds",
  "captchaImageSelector",
  "captchaInputSelector",
  "ignoreCertificateErrors",
  "logSession",
  "recordSession",
  "solveCaptchas",
  "context",
  "viewport",
] as const;

/** Canonical Verified replaces deprecated advancedStealth; extensionId has one top-level spelling. */
export const deliberatelyExcluded = [
  "browserSettings.advancedStealth",
  "browserSettings.extensionId",
] as const;
