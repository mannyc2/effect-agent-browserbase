/** Scoped synthetic responses installed through the browser's public request policy. */
import { Context, Effect, Layer, Option } from "effect";
import type { RequestDecision, RequestPolicy } from "effect-browser/Browser";
import { BrowserError, InvalidRequest } from "effect-browser/BrowserError";

type Request = Parameters<RequestPolicy["decide"]>[0];
type Respond = (
  url: URL,
  request: Request,
) => Extract<RequestDecision, { readonly _tag: "Fulfilled" }>;

const patterns = [
  "https://bench.test/*",
  "https://h1.browser.test/*",
  "https://h2.browser.test/*",
  "https://h3.browser.test/*",
];

export const makeWithPatterns = (patterns: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const routes = new Map<string, Respond>();

    return {
      policy: {
        patterns,
        decide: (request) =>
          Effect.sync(() => {
            const found = [...routes].find(([prefix]) => request.url.startsWith(prefix));

            return found === undefined
              ? { _tag: "Refused" as const, reason: "synthetic fixture has no registered response" }
              : found[1](new URL(request.url), request);
          }),
      } satisfies RequestPolicy,
      serve: (prefix: string, respond: Respond) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            routes.set(prefix, respond);
          }),
          () =>
            Effect.sync(() => {
              if (routes.get(prefix) === respond) routes.delete(prefix);
            }),
        ),
    };
  });

export const make = makeWithPatterns(patterns);

export class FixtureRoutes extends Context.Service<FixtureRoutes, Effect.Success<typeof make>>()(
  "bench/FixtureRoutes",
) {}

/** Each provider build gets a fresh book before any page can register. */
export const layer = <Out, E, R>(
  provider: (requests: RequestPolicy) => Layer.Layer<Out, E, R>,
  selectedPatterns: ReadonlyArray<string> = patterns,
) =>
  Layer.unwrap(
    Effect.map(makeWithPatterns(selectedPatterns), (book) =>
      Layer.merge(Layer.succeed(FixtureRoutes, book), provider(book.policy)),
    ),
  );

export const serve = (prefix: string, respond: Respond) =>
  Effect.gen(function* () {
    const book = yield* Effect.serviceOption(FixtureRoutes);

    if (Option.isNone(book))
      return yield* new BrowserError({
        operation: "fixture",
        dispatched: false,
        reason: new InvalidRequest({
          detail: "fixture provider must be built with FixtureRoutes.layer",
        }),
      });

    yield* book.value.serve(prefix, respond);
  });
