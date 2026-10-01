import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  ClickRequest,
  InlineFile,
  NavigateRequest,
  ReadTextRequest,
} from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
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
          const h = session.initialPage;

          yield* h.navigate(NavigateRequest.make({ url: f.url }));

          yield* session.selectFiles(
            {
              selector: "#file",
              selection: {
                _tag: "Inline",
                files: [inline("notes.txt", "in-memory bytes"), inline("second.txt", "two")],
              },
            },
            session.initialPage,
          );

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "notes.txt:15,second.txt:3",
          );
          yield* h.click(ClickRequest.make({ selector: "#readFile" }));
          yield* session.initialPage.waitFor({
            selector: "#content:not(:empty)",
            state: "visible",
          });
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#content" }))).text).toBe(
            "in-memory bytes",
          );

          // A chooser opened by a click is satisfied by exactly one attachment.
          yield* session.clickForFileSelection(
            {
              selector: "#choose",
              selection: { _tag: "Inline", files: [inline("chosen.txt", "picked")] },
            },
            session.initialPage,
          );

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "chosen.txt:6",
          );
          expect(f.uploadedPaths).toHaveLength(0);
        }),
      );
    }),
  ),
);

it.live("real CDP: provider transfers follow issued pages and reject invalid page authority", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const browser = yield* BrowserbaseBrowser;
          const session = yield* browser.open(policy);
          const destination = session.initialPage;

          yield* destination.navigate(NavigateRequest.make({ url: f.url }));
          const selected = yield* session.createPage();

          yield* session.selectPage(selected);
          yield* selected.navigate(NavigateRequest.make({ url: f.url }));
          yield* session.selectFiles(
            {
              selector: "#file",
              selection: { _tag: "Inline", files: [inline("page.txt", "exact")] },
            },
            destination,
          );
          expect(
            (yield* destination.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("page.txt:5");
          expect(
            (yield* selected.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("");

          yield* session.clickForFileSelection(
            {
              selector: "#choose",
              selection: { _tag: "Inline", files: [inline("chooser.txt", "chosen")] },
            },
            destination,
          );
          expect(
            (yield* destination.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("chooser.txt:6");
          expect(
            (yield* selected.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("");

          // The selected page has no download link. Only the issued destination can perform it.
          yield* selected.navigate(NavigateRequest.make({ url: new URL("next", f.url).href }));

          const download = yield* session.clickForDownload(
            ClickRequest.make({ selector: "#download" }),
            destination,
          );

          expect(download.filename).toBe("fixture.txt");
          expect(download.reference).toEqual(session.reference);
          expect(f.fileRequests()).toBe(1);
          yield* selected.navigate(NavigateRequest.make({ url: f.url }));

          const foreign = yield* browser.open(policy);
          const invalidPages = [{ ...destination }, foreign.initialPage];

          const request = {
            selector: "#file",
            selection: { _tag: "Inline" as const, files: [inline("refused.txt", "unsent")] },
          };

          for (const page of invalidPages) {
            for (const transfer of [
              session.selectFiles(request, page).pipe(Effect.asVoid),
              session
                .clickForFileSelection({ ...request, selector: "#choose" }, page)
                .pipe(Effect.asVoid),
              session
                .clickForDownload(ClickRequest.make({ selector: "#download" }), page)
                .pipe(Effect.asVoid),
            ]) {
              const result = yield* transfer.pipe(Effect.result);

              expect(result._tag).toBe("Failure");
              if (result._tag === "Failure") {
                expect(result.failure.reason._tag).toBe("UnregisteredSession");
                expect(result.failure.outcome).toBe("undispatched");
              }
            }
          }
          expect(
            (yield* destination.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("chooser.txt:6");
          yield* destination.close();

          for (const transfer of [
            session.selectFiles(request, destination).pipe(Effect.asVoid),
            session
              .clickForFileSelection({ ...request, selector: "#choose" }, destination)
              .pipe(Effect.asVoid),
            session
              .clickForDownload(ClickRequest.make({ selector: "#download" }), destination)
              .pipe(Effect.asVoid),
          ]) {
            const result = yield* transfer.pipe(Effect.result);

            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure.reason._tag).toBe("Closed");
              expect(result.failure.outcome).toBe("undispatched");
            }
          }
          expect(
            (yield* selected.readText(ReadTextRequest.make({ selector: "#chosen" }))).text,
          ).toBe("");
          expect(f.fileRequests()).toBe(1);
          expect(f.uploadedPaths).toHaveLength(0);
          expect(f.connections).toEqual(["session-1", "session-2"]);
        }),
      );
      expect(f.releaseIds).toEqual(["session-2", "session-1"]);
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
          const h = session.initialPage;

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

          yield* session.selectFiles(
            {
              selector: "#file",
              selection: { _tag: "Uploaded", uploads: [receipt] },
            },
            session.initialPage,
          );

          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "stored.txt:21",
          );
          yield* h.click(ClickRequest.make({ selector: "#readFile" }));
          yield* session.initialPage.waitFor({
            selector: "#content:not(:empty)",
            state: "visible",
          });
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#content" }))).text).toBe(
            "provider-stored bytes",
          );

          // A receipt this package never issued carries no attachment authority.
          const forged = yield* session
            .selectFiles(
              {
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
              },
              session.initialPage,
            )
            .pipe(Effect.result);

          expect(forged._tag).toBe("Failure");
          if (forged._tag === "Failure") {
            expect(forged.failure.reason._tag).toBe("Authorization");
            expect(forged.failure.outcome).toBe("undispatched");
          }
          // The refusal changed nothing: the earlier selection is still attached.
          expect((yield* h.readText(ReadTextRequest.make({ selector: "#chosen" }))).text).toBe(
            "stored.txt:21",
          );

          // A chooser cannot open a provider-stored path from this client.
          const chooser = yield* session
            .clickForFileSelection(
              {
                selector: "#choose",
                selection: { _tag: "Uploaded", uploads: [receipt] },
              },
              session.initialPage,
            )
            .pipe(Effect.result);

          expect(chooser._tag).toBe("Failure");
          if (chooser._tag === "Failure") expect(chooser.failure.reason._tag).toBe("Unsupported");
        }),
      );
      expect(f.releaseIds).toEqual(["session-1"]);
    }),
  ),
);
