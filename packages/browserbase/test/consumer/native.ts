// Installed-package workflow for a consumer that owns a real browser.
//
// It runs as an ordinary program on the pinned Node and Bun against a local
// Chromium process over real CDP, using only the installed package's public
// exports. The provider control plane is scripted; the browser is not.
import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import {
  InlineFile,
  NavigateRequest,
  ReadTextRequest,
} from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { Effect, Schema, Stream } from "effect";

import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

/** Trusted host configuration, installed before the document this consumer navigates to. */
const bootstrap = Bootstrap.init({
  id: "consumer-marker",
  content: `
    document.addEventListener("DOMContentLoaded", () => {
      const marker = document.createElement("p");
      marker.id = "marker";
      marker.textContent = "installed by the consumer";
      document.body.append(marker);
    });
    globalThis.__installed = true;
  `,
  readiness: {
    expression: "globalThis.__installed === true",
    timeoutMillis: 5000,
    existingDocuments: "AcceptAlreadyRunning",
  },
});

const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Consumer assertion failed: ${message}`);
};

const program = Effect.scoped(
  Effect.gen(function* () {
    const fixture = yield* localBrowser;

    return yield* withProvider(
      fixture,
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseBrowser).open(policy);

        yield* session.bind().navigate(NavigateRequest.make({ url: fixture.url }));
        const observation = yield* session.observe({ maxTextBytes: 4096, maxControls: 8 });

        expect(observation.text.includes("Local browser fixture"), "real page text is observed");
        expect(observation.controls.length > 0, "real controls are observed");

        const captured = yield* Effect.scoped(
          Effect.gen(function* () {
            const interval = yield* Capture.start(session, {
              maxFrames: 4,
              maxDurationMillis: 5000,
              size: { width: 320, height: 240 },
            });

            const frames = yield* Stream.runCollect(interval.frames.pipe(Stream.take(1)));

            expect(frames.length === 1, "live capture delivers a frame from the owned page");
            expect(
              Schema.is(Capture.CapturedFrame)(frames[0]),
              "a delivered frame is the public CapturedFrame value",
            );

            return yield* interval.stop;
          }),
        );

        expect(captured.dropped === 0, "no frame is dropped inside the bounded window");
        expect(captured.duplicates === 0, "no frame is delivered twice");

        // The registered bundle ran on the document this consumer navigated to.
        const ready = yield* session.ready;

        expect(ready._tag === "Ready", "the current document satisfied its readiness");
        expect(
          (yield* session.bind().readText(ReadTextRequest.make({ selector: "#marker" }))).text ===
            "installed by the consumer",
          "the init bundle reached the page before the consumer read it",
        );

        // Small file selection needs no provisioning of any kind.
        yield* session.selectFiles({
          selector: "#file",
          selection: {
            _tag: "Inline",
            files: [
              InlineFile.make({
                name: "notes.txt",
                mediaType: "text/plain",
                bytes: new TextEncoder().encode("consumer bytes"),
              }),
            ],
          },
        });

        expect(
          (yield* session.bind().readText(ReadTextRequest.make({ selector: "#chosen" }))).text ===
            "notes.txt:14",
          "the page received the selected file",
        );

        // A second owner borrows the same session and closes without releasing it.
        const pages = yield* session.pages;
        const selected = pages.find((page) => page.selected);

        if (selected === undefined) throw new Error("The owned session has no selected page");

        const borrowed = yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const attached = yield* (yield* BrowserbaseBrowser).attach(session.reference, {
              policy,
              target: { targetId: selected.targetId },
            });

            return yield* attached.close;
          }),
        );

        expect(borrowed.ownership === "borrowed", "a borrowed scope reports borrowed cleanup");
        expect(borrowed.releaseRequested === false, "a borrowed scope requests no release");
        expect(fixture.releaseIds.length === 0, "the borrowed scope released nothing");

        const cleanup = yield* session.close;

        expect(cleanup.ownership === "owned", "this consumer owned the session");
        expect(cleanup.local === "closed", "the local connection is closed");
        expect(cleanup.remote === "confirmed", "release is confirmed by a terminal read");
        expect(cleanup.issues.length === 0, "cleanup reports no issue");
        expect(fixture.releaseIds.length === 1, "exactly one release was requested");

        return {
          reference: cleanup.reference.sessionId,
          text: observation.text.length,
          delivered: captured.delivered,
          nativeStop: captured.nativeStop,
          borrowed: borrowed.remote,
        };
      }),
      { bootstrap },
    );
  }),
);

const result = await Effect.runPromise(program);

console.log(JSON.stringify({ profile: "generic", ...result }));
