import { Effect, Layer, Redacted, Schema } from "effect";
// A consumer started as its own process. Only the durable session reference, a target identifier
// and the fixture's addresses cross from the allocating process, as JSON in the environment; no
// closure, Scope, Layer or native object does. It borrows the session through the public API,
// changes the page, closes as a borrower and prints one JSON line.
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import * as BrowserBinding from "effect-browserbase/browser-binding";
import { BrowserPolicy, ClickRequest, ReadTextRequest } from "effect-browserbase/browser-data";
import { BrowserbaseClient } from "effect-browserbase/client";
import { BrowserError } from "effect-browserbase/errors";
import { recipe } from "effect-browserbase/launch";
import { SessionReference } from "effect-browserbase/references";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import { FetchHttpClient } from "effect/unstable/http";

const Handoff = Schema.Struct({
  reference: SessionReference,
  targetId: Schema.String,
  providerBridge: Schema.String,
  endpoint: Schema.String,
});

const handoff = Schema.decodeSync(Schema.fromJsonString(Handoff))(
  process.env.BROWSERBASE_HANDOFF ?? "",
);

// The scripted control plane lives in the allocating process; its HTTP bridge stands in for the
// provider API exactly as the in-process fetch does there.
const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  return globalThis.fetch(
    new URL(`/provider${url.pathname}${url.search}`, handoff.providerBridge),
    {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: await request.arrayBuffer() }),
    },
  );
};

const binding = BrowserBinding.playwright({
  resolveEndpoint: ({ url }) =>
    new URL(Redacted.value(url)).searchParams.get("session") === handoff.reference.sessionId
      ? Effect.succeed(handoff.endpoint)
      : Effect.fail(BrowserError.make({ operation: "connect", reason: "provider" })),
});

const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: handoff.reference.projectId,
      apiKey: Redacted.make("fixture-key-not-a-credential"),
    }),
  ),
);

const policy = BrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 60_000,
  maxReturnedBytes: 64 * 1024,
});

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser).attach(handoff.reference, {
        policy,
        target: { targetId: handoff.targetId },
      });

      const target = session.bind();
      const heading = (yield* target.readText(ReadTextRequest.make({ selector: "h1" }))).text;

      yield* target.click(ClickRequest.make({ selector: "#increment" }));
      const count = (yield* target.readText(ReadTextRequest.make({ selector: "#count" }))).text;
      const cleanup = yield* session.close;

      return { heading, count, cleanup };
    }),
  ).pipe(
    Effect.provide(
      BrowserbaseBrowser.layer({ launch: recipe(), actionTimeoutMillis: 5000 }).pipe(
        Layer.provide(account),
        Layer.provide(BrowserBinding.layer(binding)),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  ),
);

console.log(JSON.stringify({ pid: process.pid, ...result }));
