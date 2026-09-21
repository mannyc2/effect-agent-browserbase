// H4, narrowed: does a keep-alive session survive detach, and does a registration made before
// detach still run on a fresh document after reconnect? Duplicate registrations, retired
// callbacks and a reconnect from a separate process stay open.
import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { NavigateRequest } from "@effect-agent/browserbase/browser-data";
import { recipe } from "@effect-agent/browserbase/launch";
import { Effect } from "effect";

import { hostedCase } from "./harness.ts";

const h = hostedCase("keepalive-reconnect");

const origin = "https://example.com";

const plan = Bootstrap.init({
  id: "reconnect-probe",
  origins: [origin],
  content: "globalThis.__effectAgentProbe = true;",
  readiness: {
    expression: "globalThis.__effectAgentProbe === true",
    timeoutMillis: 10_000,
    existingDocuments: "RequireFreshNavigation",
  },
});

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open;

      yield* session.bind().navigate(NavigateRequest.make({ url: `${origin}/?phase=before` }));
      const before = yield* session.ready;
      const detached = yield* session.detach;

      yield* h.report("detached", detached);
      // Reconnecting asserts that no operator holds the page, which is true: none was invited.
      const reconnected = yield* session.reconnect(true);
      const selected = (yield* session.pages).find((page) => page.selected);

      yield* session.bind().navigate(NavigateRequest.make({ url: `${origin}/?phase=after` }));
      const after = yield* session.ready;
      const cleanup = yield* session.close;

      return {
        reference: session.reference,
        before,
        sameTarget: selected?.targetId === detached.targetId,
        reconnectedUrl: reconnected.url,
        after,
        cleanup,
      };
    }).pipe(Effect.provide(h.browser({ launch: recipe({ keepAlive: true }), bootstrap: plan }))),
  ),
);
