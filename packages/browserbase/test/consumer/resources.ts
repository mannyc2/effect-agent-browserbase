import { Effect, Layer, Redacted, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Reasons } from "effect-browser/errors";
import * as ScriptedBrowser from "effect-browser/testing";
// Installed-package workflow for a consumer that never opens a browser.
//
// It runs as an ordinary program on the pinned Node and Bun with only
// `effect-browserbase` and `effect` installed: no Playwright, no
// framework, no test runner. The provider is scripted through `fetch`, so the
// real Client, Sessions and artifact resources do their own parsing and bounds.
// The second half opens scripted browsers through the testing entry points:
// the real owner over a scripted engine, and the real provider Layers over a
// scripted control plane, still with no Playwright installed.
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { CleanupResult } from "effect-browserbase/cleanup";
import { BrowserbaseClient } from "effect-browserbase/client";
import { BrowserbaseExtensions } from "effect-browserbase/extensions";
import { BrowserbaseRecordings } from "effect-browserbase/recordings";
import { SessionReference } from "effect-browserbase/references";
import { BrowserbaseReplays } from "effect-browserbase/replays";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import * as ScriptedBrowserbase from "effect-browserbase/testing";
import { RecordingPageReference } from "effect-browserbase/transfers";
import { BrowserbaseUploads } from "effect-browserbase/uploads";
import { FetchHttpClient } from "effect/unstable/http";

import { extensionArchive } from "../fixtures/Zip.ts";

const reference = SessionReference.make({
  provider: "browserbase",
  projectId: "project-1",
  sessionId: "session-1",
});

const session = (status: string) => ({
  id: "session-1",
  projectId: "project-1",
  status,
  createdAt: "2026-09-20T19:00:00.000Z",
  updatedAt: "2026-09-20T19:01:00.000Z",
  expiresAt: "2026-09-20T20:00:00.000Z",
  startedAt: "2026-09-20T19:00:01.000Z",
  keepAlive: false,
  proxyBytes: 0,
  region: "us-east-1",
});

const calls: string[] = [];
let released = false;

const fetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);

  calls.push(`${request.method} ${url.pathname}`);
  if (url.origin !== "https://api.browserbase.com" && url.origin !== "https://media.example.test")
    throw new Error(`Unexpected origin: ${url.origin}`);
  if (url.pathname.endsWith("/recording/downloads")) {
    return Response.json({
      downloads: [
        {
          pageId: "0",
          status: "COMPLETED",
          downloadUrl: "https://media.example.test/video?token=SCRIPTED",
        },
      ],
    });
  }
  if (url.pathname.endsWith("/replays")) {
    return Response.json({
      pageCount: 1,
      pages: [{ pageId: "0", startTimeMs: 0, endTimeMs: 1000, url: "ignored" }],
    });
  }
  if (url.origin === "https://media.example.test") {
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-type": "video/mp4" },
    });
  }
  // Both multipart resources are parsed as an ordinary standards-conformant body.
  if (url.pathname === "/v1/extensions" && request.method === "POST") {
    const file = (await request.formData()).get("file");

    if (!(file instanceof File) || file.type !== "application/zip")
      throw new Error("Unexpected extension part");

    return Response.json({ id: "extension-1", projectId: "project-1", fileName: file.name });
  }
  if (url.pathname.startsWith("/v1/extensions/")) {
    if (request.method === "DELETE") return new Response(null, { status: 204 });

    return Response.json({
      id: "extension-1",
      projectId: "project-1",
      fileName: "extension.zip",
    });
  }
  if (url.pathname.endsWith("/uploads") && request.method === "POST") {
    const file = (await request.formData()).get("file");

    if (!(file instanceof File)) throw new Error("Unexpected upload part");

    return Response.json({
      message: "File uploaded successfully",
      path: `/browserbase/uploads/${file.name}`,
    });
  }
  if (request.method === "POST") released = true;

  return Response.json(session(released ? "COMPLETED" : "RUNNING"));
};

const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: "project-1",
      apiKey: Redacted.make("consumer-key-not-a-credential"),
      artifactOrigins: ["https://media.example.test"],
    }),
  ),
);

const expect = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`Consumer assertion failed: ${message}`);
};

const program = Effect.gen(function* () {
  const sessions = yield* BrowserbaseSessions;
  const recordings = yield* BrowserbaseRecordings;
  const replays = yield* BrowserbaseReplays;

  const running = yield* sessions.retrieve(reference);

  expect(running.status === "RUNNING", "a passive read does not release the session");
  expect(running.reference.sessionId === "session-1", "identity is preserved");

  // An unauthorized project is refused before any transport.
  const foreign = yield* sessions
    .retrieve(SessionReference.make({ ...reference, projectId: "project-2" }))
    .pipe(Effect.result);

  expect(foreign._tag === "Failure", "a foreign project reference is rejected");
  if (foreign._tag === "Failure")
    expect(foreign.failure.reason === "authorization", "rejection is an authorization failure");

  // Artifacts belong to a finished session.
  const active = yield* recordings.status(reference).pipe(Effect.result);

  expect(active._tag === "Failure", "a running session has no readable recording");
  if (active._tag === "Failure")
    expect(active.failure.reason === "active", "the refusal names the live session");

  // A provisioned extension is a durable project resource, inspected before it is sent.
  const extensions = yield* BrowserbaseExtensions;
  const registered = yield* extensions.register(extensionArchive());

  expect(registered.reference.extensionId === "extension-1", "registration is project-qualified");
  expect(registered.entries === 1, "the archive was inspected, not merely forwarded");
  expect(
    (yield* extensions.retrieve(registered.reference)).fileName === "extension.zip",
    "a registered extension is retrievable by reference",
  );
  yield* extensions.delete(registered.reference);

  const notAnExtension = yield* extensions
    .register(new TextEncoder().encode("not a zip archive at all"))
    .pipe(Effect.result);

  expect(notAnExtension._tag === "Failure", "an archive that is not an extension is refused");
  if (notAnExtension._tag === "Failure")
    expect(
      notAnExtension.failure.outcome === "undispatched",
      "the refusal happens before any transport",
    );

  // Uploading places bytes for the exact running session and issues one receipt.
  const receipt = yield* (yield* BrowserbaseUploads).create(reference, {
    filename: "report.csv",
    mediaType: "text/csv",
    bytes: new TextEncoder().encode("quarter,amount\nQ1,42\n"),
  });

  expect(receipt.reference.sessionId === "session-1", "the receipt names its own session");
  expect(
    receipt.remotePath === "/browserbase/uploads/report.csv",
    "the provider's own remote path is carried forward",
  );

  const terminal = yield* sessions.requestRelease(reference);

  expect(terminal.status === "COMPLETED", "release is an explicit mutation");

  const batch = yield* recordings.status(reference);

  expect(batch.pages.length === 1, "one recorded page");
  expect(batch.pages[0]?.delivery === "download", "a completed page is downloadable");

  const bytes = yield* recordings
    .download(RecordingPageReference.make({ session: reference, pageId: "0" }), {
      maxBytes: 1024,
      timeoutMillis: 5000,
    })
    .pipe(
      Stream.runFold(
        () => 0,
        (total: number, chunk: Uint8Array) => total + chunk.byteLength,
      ),
    );

  expect(bytes === 4, "signed media streams through the approved origin");

  const pages = yield* replays.metadata(reference);

  expect(pages.length === 1, "replay metadata is independent of recording assembly");

  return { calls, bytes, pages: pages.length };
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      BrowserbaseRecordings.layer,
      BrowserbaseReplays.layer,
      BrowserbaseExtensions.layer,
      BrowserbaseUploads.layer,
    ).pipe(Layer.provideMerge(account)),
  ),
  Effect.provideService(FetchHttpClient.Fetch, fetch),
);

const result = await Effect.runPromise(program);

const shop: ScriptedBrowser.Script = {
  documents: [
    {
      url: "https://shop.test/",
      text: "We use cookies.",
      controls: [
        {
          id: "accept",
          kind: "button",
          label: "Accept all",
          activates: "https://shop.test/?consent=1",
        },
      ],
    },
    { url: "https://shop.test/?consent=1", text: "Welcome back." },
  ],
};

const scripted = await Effect.runPromise(
  Effect.gen(function* () {
    // The generic testing entry: the real owner, no Chromium, no provider.
    const generic = yield* Browser.scoped(
      ScriptedBrowser.open(shop, { policy: BrowserPolicy.unrestricted({ maxActions: 3 }) }),
      (browser) =>
        Effect.gen(function* () {
          yield* browser.navigate({ url: "https://shop.test/" });
          const observation = yield* browser.observe();
          const accept = observation.controls[0];

          expect(accept?.label === "Accept all", "the scripted control is observed");
          if (accept === undefined) return { calls: 0 };
          yield* browser.clickElement({
            observationId: observation.observationId,
            elementId: accept.elementId,
          });
          expect(
            (yield* browser.control.document.current).url === "https://shop.test/?consent=1",
            "a click follows the scripted destination",
          );
          const budget = yield* browser.observe().pipe(Effect.result);

          expect(
            budget._tag === "Failure" &&
              budget.failure.reason._tag === "Limit" &&
              budget.failure.outcome === "undispatched",
            "the real action budget refuses undispatched work",
          );

          return { calls: (yield* browser.control.calls).length };
        }),
    );

    // An unknown outcome fences the real owner; the recorder proves nothing was re-sent.
    const uncertain = yield* Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ScriptedBrowser.open(shop);

        yield* browser.control.next("click", {
          _tag: "Fail",
          reason: Reasons.Timeout.make({}),
          outcome: "unknown",
        });
        const observation = yield* browser.observe();
        const accept = observation.controls[0];

        if (accept === undefined) throw new Error("Consumer assertion failed: no control");
        const reference = { observationId: observation.observationId, elementId: accept.elementId };
        const first = yield* browser.clickElement(reference).pipe(Effect.result);

        expect(
          first._tag === "Failure" && first.failure.outcome === "unknown",
          "the scripted outcome keeps its unknown dispatch evidence",
        );
        const retry = yield* browser.clickElement(reference).pipe(Effect.result);

        expect(
          retry._tag === "Failure" &&
            retry.failure.reason._tag === "Closed" &&
            retry.failure.outcome === "undispatched",
          "an uncertain owner refuses the retry without sending it",
        );
        const clicks = (yield* browser.control.calls).filter((call) => call.operation === "click");

        expect(
          clicks.length === 1 && clicks[0]?.dispatched === true,
          "the unknown click was dispatched once and never replayed",
        );
        const status = yield* browser.status;
        const receipt = yield* browser.close;

        return { phase: status.phase, connection: receipt.connection };
      }),
    );

    // The provider testing entry: the real account and browser Layers over scripted replies.
    const receipts: CleanupResult[] = [];

    const hosted = yield* Effect.gen(function* () {
      const handles = yield* ScriptedBrowserbase.ScriptedBrowserbase;

      const run = yield* Browser.scoped(
        BrowserbaseBrowser.open(BrowserPolicy.unrestricted()),
        (session) =>
          Effect.gen(function* () {
            yield* session.navigate({ url: "https://shop.test/" });
            const [control] = yield* handles.browsers;

            if (control === undefined) throw new Error("Consumer assertion failed: no engine");

            const delivered = yield* Effect.scoped(
              Effect.gen(function* () {
                const interval = yield* Capture.start(session, {
                  maxFrames: 2,
                  maxDurationMillis: 5000,
                });

                yield* control.capture.emit();
                const frames = yield* interval.frames.pipe(Stream.take(1), Stream.runCollect);

                return frames.length;
              }),
            );

            return { delivered, session: session.reference.sessionId };
          }),
      );

      const sessions = yield* handles.provider.sessions;

      expect(
        sessions[0]?.status === "COMPLETED" && sessions[0].releaseRequests === 1,
        "the scripted provider saw exactly one release",
      );

      return { ...run, released: sessions[0]?.releaseRequests };
    }).pipe(
      Effect.provide(
        ScriptedBrowserbase.layer({
          browser: shop,
          options: {
            onCleanup: (value) =>
              Effect.sync(() => {
                receipts.push(value);
              }),
          },
        }),
      ),
    );

    expect(
      receipts.length === 1 &&
        receipts[0]?.remote === "confirmed" &&
        receipts[0].local === "closed",
      "the real cleanup receipt confirms release over the scripted control plane",
    );

    return { generic, uncertain, hosted };
  }),
);

console.log(JSON.stringify({ profile: "resources", ...result, scripted }));
