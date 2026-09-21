import { Effect, Redacted, Schema } from "effect";

import { Viewport } from "../../BrowserData.ts";
import { BrowserError } from "../../Errors.ts";
import { LaunchRecipe, type ProxyRule } from "../../Launch.ts";
import { AllocationAttempt } from "../../References.ts";

export interface CompiledLaunch {
  readonly attempt: AllocationAttempt;
  readonly body: Schema.Json;
  readonly viewport: Viewport | undefined;
  readonly keepAlive: boolean;
  readonly context: { readonly id: string; readonly persist: boolean } | undefined;
  readonly recordSession: boolean;
}

const proxy = (rule: ProxyRule): Schema.Json =>
  rule.type === "external"
    ? {
        type: rule.type,
        server: rule.server,
        ...(rule.domainPattern === undefined ? {} : { domainPattern: rule.domainPattern }),
        ...(rule.username === undefined ? {} : { username: Redacted.value(rule.username) }),
        ...(rule.password === undefined ? {} : { password: Redacted.value(rule.password) }),
      }
    : rule.type === "none"
      ? {
          type: rule.type,
          ...(rule.domainPattern === undefined ? {} : { domainPattern: rule.domainPattern }),
        }
      : {
          type: rule.type,
          ...(rule.domainPattern === undefined ? {} : { domainPattern: rule.domainPattern }),
          ...(rule.geolocation === undefined ? {} : { geolocation: { ...rule.geolocation } }),
        };

/** One validation/copy/compiler path. No legacy constructor or second default body exists. */
export const compileLaunch = Effect.fnUntraced(function* (
  input: unknown,
  identity: Pick<AllocationAttempt, "projectId" | "attemptId" | "requestedAtMillis">,
): Effect.fn.Return<CompiledLaunch, BrowserError> {
  const recipe = yield* Schema.decodeUnknownEffect(LaunchRecipe)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      BrowserError.make({ operation: "launch", reason: "configuration", outcome: "undispatched" }),
    ),
  );

  const attempt = Object.freeze(
    AllocationAttempt.make({ ...identity, timeoutSeconds: recipe.remoteTimeoutSeconds }),
  );

  const settings = recipe.provider.browserSettings ?? {};

  const fail = () =>
    BrowserError.make({ operation: "launch", reason: "configuration", outcome: "undispatched" });

  if (
    (recipe.context !== undefined && recipe.context.reference.projectId !== attempt.projectId) ||
    (recipe.extension !== undefined && recipe.extension.projectId !== attempt.projectId) ||
    (settings.verified === true && recipe.viewport._tag !== "ProviderManaged") ||
    (settings.os !== undefined && settings.verified !== true)
  )
    return yield* fail();

  const viewport =
    recipe.viewport._tag === "Fixed"
      ? yield* Schema.decodeEffect(Viewport)({
          width: recipe.viewport.width,
          height: recipe.viewport.height,
        }).pipe(Effect.mapError(fail))
      : undefined;

  if (Array.isArray(recipe.provider.proxies)) {
    for (const rule of recipe.provider.proxies) {
      if (
        rule.type === "browserbase" &&
        rule.geolocation?.state !== undefined &&
        rule.geolocation.country !== "US"
      )
        return yield* fail();
      if (rule.type === "external") {
        const valid = yield* Effect.try({
          try: () => {
            const url = new URL(rule.server);

            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.hash
            );
          },
          catch: fail,
        });

        if (!valid) return yield* fail();
      }
    }
  }
  for (const domain of settings.allowedDomains ?? []) {
    const valid = yield* Effect.try({
      try: () => {
        const url = new URL(`https://${domain}/`);

        return (
          !domain.includes("*") &&
          url.hostname === domain &&
          !url.port &&
          !url.username &&
          !url.password
        );
      },
      catch: fail,
    });

    if (!valid) return yield* fail();
  }
  const metadata = recipe.provider.userMetadata ?? {};

  if (
    Object.keys(metadata).length > 32 ||
    Object.keys(metadata).some(
      (key) => key === "effectAgentAttempt" || key.startsWith("browserbaseIntegration"),
    )
  )
    return yield* fail();
  const keepAlive = recipe.keepAlive ?? false;

  const context =
    recipe.context === undefined
      ? undefined
      : { id: recipe.context.reference.contextId, persist: recipe.context.persist };

  const recordSession = settings.recordSession ?? false;

  const body = {
    projectId: attempt.projectId,
    timeout: recipe.remoteTimeoutSeconds,
    keepAlive,
    ...(recipe.provider.region === undefined ? {} : { region: recipe.provider.region }),
    proxies: Array.isArray(recipe.provider.proxies)
      ? recipe.provider.proxies.map(proxy)
      : (recipe.provider.proxies ?? false),
    ...(recipe.provider.proxySettings === undefined
      ? {}
      : { proxySettings: recipe.provider.proxySettings }),
    ...(recipe.extension === undefined ? {} : { extensionId: recipe.extension.extensionId }),
    browserSettings: {
      ...settings,
      recordSession,
      logSession: settings.logSession ?? false,
      solveCaptchas: settings.solveCaptchas ?? false,
      ...(context === undefined ? {} : { context }),
      ...(viewport === undefined
        ? {}
        : { viewport: { width: viewport.width, height: viewport.height } }),
    },
    userMetadata: { ...metadata, browserbaseIntegrationAttempt: attempt.attemptId },
  };

  // Own all nested values, including arrays. The admitted body never observes later caller mutation.
  const encoded = yield* Effect.try({ try: () => JSON.stringify(body), catch: fail });

  if (new TextEncoder().encode(encoded).length > 64 * 1024) return yield* fail();

  const owned = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(encoded).pipe(
    Effect.mapError(fail),
  );

  return { attempt, body: owned, viewport, keepAlive, context, recordSession };
});
