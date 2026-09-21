// Operator takeover and release, which no script can do on a person's behalf. The check opens a
// session, hands its Live View to the operator at this terminal, waits for them to act and
// say so, then resumes and reports what the page looks like afterwards. The Live View URL
// grants control, so it goes to the terminal only and never into the JSON record.
import { NavigateRequest } from "@effect-agent/browserbase/browser-data";
import { recipe } from "@effect-agent/browserbase/launch";
import { Effect, Redacted } from "effect";

import { hostedCase } from "./harness.ts";

const h = hostedCase("handoff");

const start = "https://example.com/";

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open;

      yield* session.bind().navigate(NavigateRequest.make({ url: start }));
      const handoff = yield* session.beginHandoff(240);
      const page = handoff.view.pages[0];

      if (page === undefined) return yield* Effect.die("the provider issued no Live View page");
      yield* h.report("handoff-issued", { pages: handoff.view.pages.length });

      const answer = yield* h.ask(
        [
          `Open this Live View and take control: ${Redacted.value(page.url)}`,
          `Click the "More information..." link on ${start}, then leave the browser alone.`,
          'Type "released" once you have let go, or anything else to abandon the check.',
        ].join("\n"),
        240_000,
      );

      const released = answer.trim() === "released";

      yield* h.report("operator", { released });
      // The boolean is the operator's own statement, never inferred from the page.
      const observation = yield* session.resume(handoff.token, released);
      const cleanup = yield* session.close;

      return {
        reference: session.reference,
        released,
        moved: observation.url !== start,
        url: observation.url,
        cleanup,
      };
    }).pipe(Effect.provide(h.browser({ launch: recipe() }))),
  ),
);
