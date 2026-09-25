/**
 * Reviewed request subset, not a generated SDK or a claim of automatic upstream coverage.
 * `tools/verify-launch-contract.mjs` re-derives the inventory below from exactly these
 * bytes; the digest is what makes the citation checkable rather than merely stated.
 */
export const contractSource = {
  repository: "browserbase/sdk-node",
  revision: "fe805b86cd860436eae63a2551b12cf02d708ce1",
  version: "2.20.0",
  resource: "src/resources/sessions/sessions.ts",
  sha256: "16e928bb821cf5497f11d08fea12807b41914d8b88873af7aad6d33e9acee4b3",
  spec: "https://docs.browserbase.com/reference/api/openapi.v1.yaml",
} as const;

/** SDK argument names that differ from the wire field they send. The body never says `api_timeout`. */
export const sessionCreateRenames = { api_timeout: "timeout" } as const;

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

/** Pinned SDK shape for GET `/v1/sessions/{id}/debug`; the published spec omits this query. */
export const sessionDebugParams = ["expiresIn"] as const;

/** Pinned SDK and OpenAPI response keys; parsing consumes only the two fullscreen URLs and IDs. */
export const sessionLiveUrlsFields = [
  "debuggerFullscreenUrl",
  "debuggerUrl",
  "pages",
  "wsUrl",
] as const;

export const sessionLiveUrlsPageFields = [
  "id",
  "url",
  "faviconUrl",
  "title",
  "debuggerUrl",
  "debuggerFullscreenUrl",
] as const;

/** The current OpenAPI operation declares only the path id, not the SDK's optional query. */
export const sessionLiveUrlsSpecParameters = [{ name: "id", location: "path" }] as const;
