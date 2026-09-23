import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { sequentialCrypto, type Script } from "effect-browser/testing";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import * as Account from "../src/Account.ts";
import * as Allocation from "../src/Allocation.ts";
import { BrowserbaseBrowser } from "../src/Browser.ts";
import type { CleanupResult } from "../src/Cleanup.ts";
import { recipe } from "../src/Launch.ts";
import { BrowserbaseSessions } from "../src/Sessions.ts";
import * as Testing from "../src/Testing.ts";
import { BrowserbaseUploads } from "../src/Uploads.ts";

const origin = "https://shop.test";

const shop: Script = {
  documents: [
    {
      url: `${origin}/`,
      text: "Welcome. We use cookies.",
      controls: [
        { id: "accept", kind: "button", label: "Accept all", activates: `${origin}/?consent=1` },
        { id: "upload", kind: "input", label: "Upload", inputType: "file" },
      ],
    },
    { url: `${origin}/?consent=1`, text: "Welcome back." },
  ],
};

const policy = BrowserPolicy.unrestricted({ maxActions: 20 });

const leaks = (evidence: unknown, control: Testing.ProviderControl) => {
  const text = JSON.stringify(evidence);

  return [control.secrets.apiKey, control.secrets.connectUrl, control.secrets.liveView].filter(
    (secret) => text.includes(secret),
  );
};

it.effect(
  "allocates, connects over the scripted engine and releases with a confirmed receipt",
  () => {
    const receipts: CleanupResult[] = [];

    return Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;

      const result = yield* Browser.scoped(BrowserbaseBrowser.open(policy), (session) =>
        Effect.gen(function* () {
          expect(session.implementation).toBe("browserbase-playwright-cdp");
          expect(session.reference).toMatchObject({
            provider: "browserbase",
            projectId: "project-1",
            sessionId: "session-1",
          });
          yield* session.navigate({ url: `${origin}/` });
          expect((yield* session.observe()).text).toBe("Welcome. We use cookies.");
          expect((yield* scripted.provider.sessions)[0]).toMatchObject({
            id: "session-1",
            status: "RUNNING",
            releaseRequests: 0,
          });
          const view = yield* session.liveView(30);

          expect(Redacted.value(view.session)).toContain(scripted.provider.secrets.liveView);
          expect(JSON.stringify(view)).not.toContain(scripted.provider.secrets.liveView);
          expect(view.requestedTtlSeconds).toBe(30);

          return yield* session.closeChecked;
        }),
      );

      expect(result).toMatchObject({
        ownership: "owned",
        releaseRequested: true,
        remote: "confirmed",
        local: "closed",
        observedStatus: "COMPLETED",
        issues: [],
      });
      expect(receipts).toEqual([result]);
      expect((yield* scripted.provider.sessions)[0]).toMatchObject({
        status: "COMPLETED",
        releaseRequests: 1,
      });
      const calls = (yield* scripted.provider.calls).map((call) => `${call.method} ${call.path}`);

      expect(calls).toEqual(
        expect.arrayContaining([
          "POST /v1/sessions",
          "GET /v1/sessions/session-1",
          "GET /v1/sessions/session-1/debug",
          "POST /v1/sessions/session-1",
        ]),
      );
      const [browser] = yield* scripted.browsers;

      expect(browser).toBeDefined();
      if (browser === undefined) return;
      expect((yield* browser.calls).map((call) => call.operation)).toEqual(["navigate", "observe"]);
      expect(leaks([result, calls, yield* browser.calls], scripted.provider)).toEqual([]);
    }).pipe(
      Effect.provide(
        Testing.layer({
          browser: shop,
          options: {
            onCleanup: (result) =>
              Effect.sync(() => {
                receipts.push(result);
              }),
          },
        }),
      ),
    );
  },
);

it.effect("a rejected allocation is a typed rejection with no session to release", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.scoped(BrowserbaseBrowser.open(policy)).pipe(Effect.flip);

    expect(failure).toMatchObject({
      _tag: "AllocationError",
      outcome: "rejected",
      reason: "rate-limited",
      status: 429,
    });
    const scripted = yield* Testing.ScriptedBrowserbase;

    expect(yield* scripted.provider.sessions).toEqual([]);
    expect(yield* scripted.browsers).toEqual([]);
    expect(leaks(failure, scripted.provider)).toEqual([]);
  }).pipe(
    Effect.provide(
      Testing.layer({
        browser: shop,
        provider: { create: { _tag: "Reject", status: 429, retryAfterMillis: 1000 } },
      }),
    ),
  ),
);

it.effect("a lost creation reply is an unknown allocation, reported exactly once", () => {
  const uncertain: string[] = [];

  return Effect.gen(function* () {
    const failure = yield* Effect.scoped(BrowserbaseBrowser.open(policy)).pipe(Effect.flip);

    expect(failure).toMatchObject({
      _tag: "AllocationError",
      outcome: "unknown",
      reason: "transport",
    });
    expect(uncertain).toHaveLength(1);
    const scripted = yield* Testing.ScriptedBrowserbase;

    expect((yield* scripted.provider.calls).map((call) => call.method)).toEqual(["POST"]);
  }).pipe(
    Effect.provide(
      Testing.layer({
        browser: shop,
        provider: { create: { _tag: "Lost" } },
        options: {
          onAllocationUncertain: (attempt) =>
            Effect.sync(() => {
              uncertain.push(attempt.attemptId);
            }),
        },
      }),
    ),
  );
});

it.effect(
  "a release the provider does not confirm is reported as pending, under the test clock",
  () => {
    const receipts: CleanupResult[] = [];

    return Effect.gen(function* () {
      const workflow = Browser.scoped(BrowserbaseBrowser.open(policy), (session) =>
        session.observe(),
      ).pipe(
        Effect.provide(
          Testing.layer({
            browser: shop,
            provider: { release: "pending" },
            options: {
              onCleanup: (result) =>
                Effect.sync(() => {
                  receipts.push(result);
                }),
            },
          }),
        ),
      );

      const fiber = yield* workflow.pipe(Effect.forkScoped);

      // Terminal-status polling sleeps on the Effect clock; the test drives it past its bound.
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toMatchObject({
        _tag: "BrowserError",
        operation: "close",
        reason: { _tag: "Provider" },
        outcome: "unknown",
      });
      expect(receipts[0]).toMatchObject({
        releaseRequested: true,
        remote: "pending",
        local: "closed",
        issues: [{ step: "status", reason: "timeout" }],
      });
    });
  },
);

it.effect("a borrowed attachment disconnects without releasing the owner's session", () =>
  Effect.gen(function* () {
    const scripted = yield* Testing.ScriptedBrowserbase;

    yield* Browser.scoped(BrowserbaseBrowser.open(policy), (owner) =>
      Effect.gen(function* () {
        const page = (yield* owner.pages).find((candidate) => candidate.selected);

        expect(page).toBeDefined();
        if (page === undefined) return;

        const borrowed = yield* Effect.scoped(
          BrowserbaseBrowser.attach(owner.reference, {
            policy,
            target: { targetId: page.targetId },
          }).pipe(Effect.flatMap((attached) => attached.close)),
        );

        expect(borrowed).toMatchObject({
          ownership: "borrowed",
          releaseRequested: false,
          remote: "not-owned",
          local: "closed",
        });
        expect((yield* scripted.provider.sessions)[0]).toMatchObject({ releaseRequests: 0 });
        expect((yield* scripted.browsers).length).toBe(2);
      }),
    );
    expect((yield* scripted.provider.sessions)[0]).toMatchObject({
      status: "COMPLETED",
      releaseRequests: 1,
    });
  }).pipe(Effect.provide(Testing.layer({ browser: shop }))),
);

it.effect("an upload receipt authorizes file selection for the exact session", () =>
  Effect.gen(function* () {
    const scripted = yield* Testing.ScriptedBrowserbase;
    const uploads = yield* BrowserbaseUploads;

    yield* Browser.scoped(BrowserbaseBrowser.open(policy), (session) =>
      Effect.gen(function* () {
        const receipt = yield* uploads.create(session.reference, {
          filename: "notes.txt",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("hello"),
        });

        expect(receipt.remotePath).toBe("/tmp/.uploads/notes.txt");
        expect((yield* scripted.provider.sessions)[0]?.uploads).toEqual(["notes.txt"]);
        yield* session.selectFiles({
          selector: "#upload",
          selection: { _tag: "Uploaded", uploads: [receipt] },
        });
        const [browser] = yield* scripted.browsers;

        expect(browser).toBeDefined();
        if (browser === undefined) return;
        expect((yield* browser.document.files).get("upload")).toEqual(["/tmp/.uploads/notes.txt"]);
      }),
    );
  }).pipe(Effect.provide(Testing.layer({ browser: shop }))),
);

it.effect("the scripted control plane serves the resource services and scoped allocation", () =>
  Effect.gen(function* () {
    const scripted = yield* Testing.provider();

    const reference = yield* Effect.scoped(
      Allocation.scoped(recipe()).pipe(
        Effect.flatMap((allocated) =>
          Effect.gen(function* () {
            const sessions = yield* BrowserbaseSessions;

            // The attempt id is the first value drawn from the provided Crypto.
            expect(allocated.attempt.attemptId).toBe("00000000-0000-4000-8000-000000000001");
            expect((yield* sessions.retrieve(allocated.reference)).status).toBe("RUNNING");
            expect((yield* sessions.list()).map((session) => session.reference.sessionId)).toEqual([
              "session-1",
            ]);

            return allocated.reference;
          }),
        ),
      ),
    ).pipe(
      // Allocation draws its attempt id from a Crypto; the scripted one needs no platform package.
      Effect.provide(
        Layer.merge(
          Account.layer({
            projectId: scripted.control.projectId,
            apiKey: Redacted.make(scripted.control.secrets.apiKey),
          }),
          sequentialCrypto,
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, scripted.fetch),
    );

    expect(reference.sessionId).toBe("session-1");
    expect((yield* scripted.control.sessions)[0]).toMatchObject({
      status: "COMPLETED",
      releaseRequests: 1,
    });
    expect(leaks(reference, scripted.control)).toEqual([]);
  }),
);

it.effect("an invalid provider script is a configuration failure", () =>
  Effect.gen(function* () {
    const failure = yield* Testing.provider({ release: "later" } as never).pipe(Effect.flip);

    expect(failure).toMatchObject({
      _tag: "ClientError",
      operation: "configure",
      reason: "configuration",
    });
  }),
);
