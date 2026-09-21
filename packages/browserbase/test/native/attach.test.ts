import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import {
  ClickRequest,
  NavigateRequest,
  ReadTextRequest,
} from "@effect-agent/browserbase/browser-data";
import type { SessionReference } from "@effect-agent/browserbase/references";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { localBrowser, localLaunch, policy, withProvider } from "../fixtures/LocalBrowser.ts";

it.live("real CDP: a borrowed attachment drives a running session and never releases it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const owner = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* owner.bind().navigate(NavigateRequest.make({ url: f.url }));
          const pages = yield* owner.pages;
          const selected = pages.find((page) => page.selected);

          expect(selected).toBeDefined();
          const reference = owner.reference;

          // A second owner borrows the same session, exactly as another process would:
          // no closure from the allocating scope crosses over, only the reference.
          yield* withProvider(
            f,
            Effect.gen(function* () {
              const borrowed = yield* (yield* BrowserbaseBrowser).attach(reference, {
                policy,
                target: { targetId: selected!.targetId },
              });

              expect(
                (yield* borrowed.bind().readText(ReadTextRequest.make({ selector: "h1" }))).text,
              ).toBe("Local browser fixture");
              yield* borrowed.bind().click(ClickRequest.make({ selector: "#increment" }));

              // Detaching and reattaching inside a borrowed scope is deliberately absent.
              const unsupported = yield* borrowed.detach.pipe(Effect.result);

              expect(unsupported._tag).toBe("Failure");
              if (unsupported._tag === "Failure")
                expect(unsupported.failure.reason).toBe("unsupported");

              const report = yield* borrowed.close;

              expect(report.ownership).toBe("borrowed");
              expect(report.remote).toBe("not-owned");
              expect(report.releaseRequested).toBe(false);
              expect(report.local).toBe("closed");
            }),
          );

          // The allocating owner still holds the same live session, and sees the work done.
          expect(
            (yield* owner.bind().readText(ReadTextRequest.make({ selector: "#count" }))).text,
          ).toBe("1");
          expect(f.releaseIds).toEqual([]);
        }),
        { launch: { ...localLaunch, keepAlive: true } },
      );
      // Exactly one release, by the scope that allocated the session.
      expect(f.releaseIds).toEqual(["session-1"]);
      expect(f.connections).toEqual(["session-1", "session-1"]);
    }),
  ),
);

it.live("real CDP: a terminal session is not reattachable and an unknown target is explicit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;
      let reference: SessionReference | undefined;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const owner = yield* (yield* BrowserbaseBrowser).open(policy);

          reference = owner.reference;
          yield* owner.bind().navigate(NavigateRequest.make({ url: f.url }));
          yield* owner.createPage;

          yield* withProvider(
            f,
            Effect.gen(function* () {
              // No positional fallback: an unknown page is a failure, not the first tab.
              const missing = yield* (yield* BrowserbaseBrowser)
                .attach(owner.reference, { policy, target: { targetId: "not-a-real-target" } })
                .pipe(Effect.result);

              expect(missing._tag).toBe("Failure");
              if (missing._tag === "Failure") expect(missing.failure.reason).toBe("not-found");

              // Nor does an unnamed target quietly pick one of several open pages.
              const ambiguous = yield* (yield* BrowserbaseBrowser)
                .attach(owner.reference, { policy })
                .pipe(Effect.result);

              expect(ambiguous._tag).toBe("Failure");
              if (ambiguous._tag === "Failure") expect(ambiguous.failure.reason).toBe("ambiguous");
            }),
          );
          yield* owner.close;
        }),
      );

      expect(reference).toBeDefined();
      yield* withProvider(
        f,
        Effect.gen(function* () {
          const expired = yield* (yield* BrowserbaseBrowser)
            .attach(reference!, { policy })
            .pipe(Effect.result);

          expect(expired._tag).toBe("Failure");
          if (expired._tag === "Failure") {
            expect(expired.failure._tag).toBe("SessionError");
            expect(expired.failure.reason).toBe("expired");
            if (expired.failure._tag === "SessionError")
              expect(expired.failure.outcome).toBe("undispatched");
          }
        }),
      );
      expect(f.releaseIds).toEqual(["session-1"]);
    }),
  ),
);
