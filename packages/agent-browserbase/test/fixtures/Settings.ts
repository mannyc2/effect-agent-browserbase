import { Context, Effect, Schema } from "effect";
import * as Bootstrap from "effect-browserbase/bootstrap";

export class SettingsUnavailable extends Schema.TaggedError<SettingsUnavailable>()(
  "SettingsUnavailable",
  { revision: Schema.Finite },
) {}

export const SettingsValue = Schema.Struct({
  label: Schema.String,
  revision: Schema.FiniteFromString,
});

export class Settings extends Context.Service<
  Settings,
  {
    readonly read: (
      revision: number,
    ) => Effect.Effect<typeof SettingsValue.Type, SettingsUnavailable>;
  }
>()("agent-bindings/Settings") {}

/** The same typed host-service registration is exercised by native tests and packed consumers. */
export const settingsBootstrap = (origin: string) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: "getAgentSettings",
      origins: [origin],
      input: Schema.Struct({ revision: Schema.FiniteFromString }),
      output: SettingsValue,
      maxConcurrent: 2,
      maxInputBytes: 128,
      maxOutputBytes: 512,
      timeoutMillis: 3000,
      failureMode: "fail-session",
      handle: ({ revision }) => Effect.flatMap(Settings, (settings) => settings.read(revision)),
    }),
    Bootstrap.init({
      id: "agent-settings-ready",
      origins: [origin],
      content: `
      const loaded = document.readyState === "loading"
        ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }))
        : Promise.resolve();
      globalThis.__agentSettingsReady = Promise.all([
        globalThis.getAgentSettings({ revision: "7" }), loaded
      ]).then(([settings]) => {
        const marker = document.createElement("p");
        marker.id = "agent-settings";
        marker.textContent = settings.label + ":" + settings.revision;
        const trigger = document.createElement("button");
        trigger.id = "unavailable-settings";
        trigger.textContent = "Request unavailable settings";
        trigger.onclick = () => { void globalThis.getAgentSettings({ revision: "-1" }).catch(() => {}); };
        document.body.append(marker, trigger);
        return settings.revision === "7";
      });
    `,
      readiness: {
        expression: "globalThis.__agentSettingsReady",
        timeoutMillis: 5000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );
