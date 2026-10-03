import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";

export const publicOrigin = "https://example.com";

export const hostedUrl = (origin: string, route: string) =>
  `${origin}/?scene=${encodeURIComponent(route)}`;

/** Trusted fixture markup and scripts, with independent truth recorded by a host binding. */
export const injectedSite = (options: {
  readonly origins: ReadonlyArray<string>;
  readonly markup: string;
  readonly script: string;
  readonly record: (event: Schema.Json) => void;
}) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: "recordBenchTruth",
      origins: options.origins,
      input: Schema.Json,
      output: Schema.Null,
      maxConcurrent: 16,
      maxInputBytes: 16384,
      maxOutputBytes: 16,
      timeoutMillis: 3000,
      failureMode: "reject-call",
      handle: (event) =>
        Effect.sync(() => {
          options.record(event);

          return null;
        }),
    }),
    Bootstrap.init({
      id: "bench-fixture",
      origins: options.origins,
      content: `(() => { const render = () => { document.head.innerHTML = '<meta charset="utf-8"><title>Watched browsing</title>'; document.body.innerHTML = ${JSON.stringify(options.markup)}; ${options.script} return true; }; globalThis.__benchFixture = document.readyState === 'loading' ? new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(render()), { once:true })) : Promise.resolve(render()); })();`,
      readiness: {
        expression: "globalThis.__benchFixture",
        timeoutMillis: 10000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );
