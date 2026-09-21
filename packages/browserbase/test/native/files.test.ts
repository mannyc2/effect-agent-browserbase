import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import {
  ClickRequest,
  InlineFile,
  NavigateRequest,
  ReadTextRequest,
} from "effect-browserbase/browser-data";
import { UploadReceipt } from "effect-browserbase/transfers";
import { BrowserbaseUploads } from "effect-browserbase/uploads";

import { account, localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

const inline = (name: string, text: string) =>
  InlineFile.make({
    name,
    mediaType: "text/plain",
    bytes: new TextEncoder().encode(text),
  });

const uploads = BrowserbaseUploads.layer.pipe(Layer.provide(account));

it.live("real CDP: in-memory selection reaches the page without any provisioning", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const h = session.bind();

          yield* h.navigate(NavigateRequest.make({ url: f.url }));

          yield* session.selectFiles({
            selector: "#file",
            selection: {
              _tag: "Inline",
              files: [inline("notes.txt", "in-memory bytes"), inline("second.txt", "two")],
            },
          });

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "notes.txt:15,second.txt:3",
          );
          yield* h.click(ClickRequest.make({ selector: "#readFile" }));
          yield* session.waitFor({ selector: "#content:not(:empty)", state: "visible" });
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#content" }))).text).toBe(
            "in-memory bytes",
          );

          // A chooser opened by a click is satisfied by exactly one attachment.
          yield* session.clickForFileSelection({
            selector: "#choose",
            selection: { _tag: "Inline", files: [inline("chosen.txt", "picked")] },
          });

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "chosen.txt:6",
          );
          expect(f.uploadedPaths).toHaveLength(0);
        }),
      );
    }),
  ),
);

it.live("real CDP: an uploaded file is opened by the browser, not streamed from this client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const h = session.bind();

          yield* h.navigate(NavigateRequest.make({ url: f.url }));

          const receipt = yield* Effect.provide(
            Effect.gen(function* () {
              const service = yield* BrowserbaseUploads;

              return yield* service.create(session.reference, {
                filename: "stored.txt",
                mediaType: "text/plain",
                bytes: new TextEncoder().encode("provider-stored bytes"),
              });
            }),
            uploads,
          );

          expect(receipt.remotePath).toBe(f.uploadedPaths[0]);

          yield* session.selectFiles({
            selector: "#file",
            selection: { _tag: "Uploaded", uploads: [receipt] },
          });

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "stored.txt:21",
          );
          yield* h.click(ClickRequest.make({ selector: "#readFile" }));
          yield* session.waitFor({ selector: "#content:not(:empty)", state: "visible" });
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#content" }))).text).toBe(
            "provider-stored bytes",
          );

          // A receipt this package never issued carries no attachment authority.
          const forged = yield* session
            .selectFiles({
              selector: "#file",
              selection: {
                _tag: "Uploaded",
                uploads: [
                  UploadReceipt.make({
                    reference: session.reference,
                    filename: "stored.txt",
                    bytes: 21,
                    remotePath: "/etc/hostname",
                  }),
                ],
              },
            })
            .pipe(Effect.result);

          expect(forged._tag).toBe("Failure");
          if (forged._tag === "Failure") {
            expect(forged.failure.reason).toBe("authorization");
            expect(forged.failure.outcome).toBe("undispatched");
          }
          // The refusal changed nothing: the earlier selection is still attached.
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "stored.txt:21",
          );

          // A chooser cannot open a provider-stored path from this client.
          const chooser = yield* session
            .clickForFileSelection({
              selector: "#choose",
              selection: { _tag: "Uploaded", uploads: [receipt] },
            })
            .pipe(Effect.result);

          expect(chooser._tag).toBe("Failure");
          if (chooser._tag === "Failure") expect(chooser.failure.reason).toBe("unsupported");
        }),
      );
      expect(f.releaseIds).toEqual(["session-1"]);
    }),
  ),
);
