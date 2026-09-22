import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";

import {
  localBrowser,
  localLaunch,
  policy,
  settle,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

/** Every reviewed capability is granted against a real browser, not asserted from a list. */
const reviewed = [...Bootstrap.Permission.literals];

const ordered = (origin: string) =>
  Bootstrap.combine(
    Bootstrap.permissions({ origin, permissions: reviewed }),
    Bootstrap.init({ id: "first", content: "globalThis.__first = 1;" }),
    Bootstrap.init({
      id: "second",
      origins: [origin],
      content: `
        globalThis.__second = globalThis.__first + 1;
        globalThis.__granted = Promise.resolve().then(() => Notification.permission === "granted");
        document.addEventListener("DOMContentLoaded", () => {
          const marker = document.createElement("p");
          marker.id = "marker";
          marker.textContent = "bootstrap " + globalThis.__second;
          document.body.append(marker);
        });
      `,
      readiness: {
        expression: "globalThis.__second === 2 && globalThis.__granted",
        timeoutMillis: 5000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );

const always = Bootstrap.init({
  id: "always",
  content: "globalThis.__ready = true;",
  readiness: {
    expression: "globalThis.__ready === true",
    timeoutMillis: 5000,
    existingDocuments: "RequireFreshNavigation",
  },
});

it.live("real CDP: one ordered bundle, granted capabilities and per-document readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;
      const origin = new URL(f.url).origin;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy, {
            bootstrap: ordered(origin),
          });

          const h = yield* session.retain;

          // The page this connection attached to was already open, so it never ran the
          // bundle. That is reported rather than hidden by an automatic reload.
          expect(yield* session.ready).toEqual({ _tag: "RequiresNavigation" });
          yield* h.navigate(NavigateRequest.make({ url: f.url }));

          // Dependent work waits for the document, and the bundle ran in declared order.
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#marker" }))).text).toBe(
            "bootstrap 2",
          );
          expect(
            yield* session.ready,
            "the main document completed its registered readiness",
          ).toEqual({ _tag: "Ready" });

          // A frame is its own document: the context-level registration reached it, and
          // readiness follows the selected frame rather than the page that contains it.
          // The main frame reaching DOMContentLoaded says nothing about its iframe: that frame
          // is attached, and then navigated, by native events that arrive on their own schedule.
          const frames = yield* settle(session.frames, (listed) =>
            listed.some((frame) => frame.name === "child" && frame.url.endsWith("/frame")),
          );

          const child = frames.find((frame) => frame.name === "child");
          const main = frames.find((frame) => frame.parentFrameId === null);

          if (child === undefined || main === undefined)
            throw new Error("The fixture page has a main frame and a child frame");
          yield* session.selectFrame(child.frameId);
          expect(
            yield* session.ready,
            "the selected child completed its own registered readiness",
          ).toEqual({ _tag: "Ready" });
          expect((yield* session.observe()).text).toContain("frame text");
          // Selecting a frame retires the earlier handle, so the main frame is re-bound.
          yield* session.selectFrame(main.frameId);
          expect((yield* h.readText(ReadTextRequest.make({})).pipe(Effect.result))._tag).toBe(
            "Failure",
          );

          // A different origin is outside the registration, and says so rather than waiting.
          yield* session.navigate(
            NavigateRequest.make({ url: f.url.replace("127.0.0.1", "localhost") }),
          );
          expect(yield* session.ready).toEqual({ _tag: "NotApplicable" });
          expect((yield* session.observe()).url).toContain("localhost");
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: a reattached document that predates the registrations is reported, not used",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy, {
              bootstrap: always,
            });

            yield* session.navigate(NavigateRequest.make({ url: f.url }));
            expect(yield* session.ready).toEqual({ _tag: "Ready" });
            yield* session.detach;

            // Reconnecting re-registers for the new connection; the running document did not
            // run that registration, so it is reported instead of silently reloaded.
            const observation = yield* session.reconnect(true);

            expect(observation.url).toContain("127.0.0.1");
            expect(yield* session.ready).toEqual({ _tag: "RequiresNavigation" });

            const refused = yield* session
              .readText(ReadTextRequest.make({ selector: "h1" }))
              .pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") {
              expect(refused.failure.reason._tag).toBe("Stale");
              expect(refused.failure.outcome).toBe("undispatched");
            }

            // Deliberate navigation is what initializes it, and is never gated.
            yield* session.navigate(NavigateRequest.make({ url: f.url }));
            expect(yield* session.ready).toEqual({ _tag: "Ready" });
            expect((yield* session.readText(ReadTextRequest.make({ selector: "h1" }))).text).toBe(
              "Local browser fixture",
            );
          }),
          { launch: { ...localLaunch, keepAlive: true } },
        );
        expect(f.connections).toEqual(["session-1", "session-1"]);
      }),
    ),
);

it.live("real CDP: an accepted running document admits dependent work after reattachment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      const accepting = Bootstrap.init({
        id: "always",
        content: "globalThis.__ready = true;",
        readiness: {
          expression: "globalThis.__ready === true",
          timeoutMillis: 5000,
          existingDocuments: "AcceptAlreadyRunning",
        },
      });

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy, {
            bootstrap: accepting,
          });

          yield* session.navigate(NavigateRequest.make({ url: f.url }));
          yield* session.detach;
          yield* session.reconnect(true);

          // The same document still satisfies the requirement, so it is verified, not assumed.
          expect(yield* session.ready).toEqual({ _tag: "Ready" });
          expect((yield* session.readText(ReadTextRequest.make({ selector: "h1" }))).text).toBe(
            "Local browser fixture",
          );
        }),
        { launch: { ...localLaunch, keepAlive: true } },
      );
    }),
  ),
);
