import assert from "node:assert/strict";

import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { BrowserError } from "../src/Errors.ts";
import { compileBootstrap, duplicateStep } from "../src/internal/browser/Bootstrap.ts";
import { fixture } from "./fixtures/ScriptedProvider.ts";

const script = (id: string, content: string, extra: Partial<Bootstrap.InitScript> = {}) =>
  Bootstrap.init({ id, content, ...extra });

const readiness = (expression: string, existing: Bootstrap.Readiness["existingDocuments"]) => ({
  expression,
  timeoutMillis: 1000,
  existingDocuments: existing,
});

it("bundles dependent steps in declared order and keeps their origin guards", () => {
  const plan = Bootstrap.combine(
    Bootstrap.permissions({ origin: "https://portal.example.com", permissions: ["geolocation"] }),
    script("first", "globalThis.first = 1;"),
    script("second", "globalThis.second = globalThis.first + 1;", {
      origins: ["https://portal.example.com"],
      readiness: readiness("globalThis.second === 2", "RequireFreshNavigation"),
    }),
  );

  const compiled = compileBootstrap(plan);

  assert.ok(compiled);
  const bundle = compiled.bundle ?? "";

  expect(bundle.indexOf("globalThis.first")).toBeLessThan(bundle.indexOf("globalThis.second"));
  expect(bundle).toContain('const origins = ["https://portal.example.com"];');
  expect(bundle.startsWith("(() => {")).toBe(true);
  expect(compiled.permissions).toEqual([
    { origin: "https://portal.example.com", permissions: ["geolocation"] },
  ]);
  expect(compiled.readiness).toEqual([
    {
      step: "second",
      expression: "globalThis.second === 2",
      timeoutMillis: 1000,
      origins: ["https://portal.example.com"],
    },
  ]);
  expect(compiled.existingDocuments).toBe("RequireFreshNavigation");
  expect(compileBootstrap(Bootstrap.empty)).toBeUndefined();
});

it("resolves disagreeing existing-document policies to the conservative one", () => {
  const relaxed = script("a", "globalThis.a = 1;", {
    readiness: readiness("globalThis.a === 1", "AcceptAlreadyRunning"),
  });

  const strict = script("b", "globalThis.b = 1;", {
    readiness: readiness("globalThis.b === 1", "RequireFreshNavigation"),
  });

  expect(compileBootstrap(relaxed)?.existingDocuments).toBe("AcceptAlreadyRunning");
  expect(compileBootstrap(Bootstrap.combine(relaxed, strict))?.existingDocuments).toBe(
    "RequireFreshNavigation",
  );
});

it("refuses ambiguous step identity and values a document cannot honour", () => {
  expect(duplicateStep(Bootstrap.combine(script("a", "1;"), script("a", "2;")))).toBe(true);

  expect(
    duplicateStep(
      Bootstrap.combine(
        Bootstrap.permissions({ origin: "https://a.example", permissions: ["camera"] }),
        Bootstrap.permissions({ origin: "https://a.example", permissions: ["microphone"] }),
      ),
    ),
  ).toBe(true);
  expect(duplicateStep(Bootstrap.combine(script("a", "1;"), script("b", "2;")))).toBe(false);

  const invalid: ReadonlyArray<unknown> = [
    { scripts: [{ id: "a", content: "1;", origins: ["https://a.example/path"] }], permissions: [] },
    { scripts: [], permissions: [{ origin: "https://a.example", permissions: ["file-system"] }] },
    { scripts: [], permissions: [{ origin: "wss://a.example", permissions: ["camera"] }] },
    {
      scripts: [],
      permissions: [{ origin: "https://a.example", permissions: ["camera", "camera"] }],
    },
    { scripts: [{ id: "a", content: "" }], permissions: [] },
  ];

  for (const candidate of invalid)
    expect(Schema.decodeUnknownExit(Bootstrap.Plan)(candidate)._tag).toBe("Failure");
  expect(
    Schema.decodeUnknownExit(Bootstrap.Plan)(
      Bootstrap.combine(
        script("a", "1;", { origins: ["http://127.0.0.1:8080"] }),
        Bootstrap.permissions({ origin: "https://a.example", permissions: ["clipboard-read"] }),
      ),
    )._tag,
  ).toBe("Success");
});

it.effect("a document that predates the registrations cannot admit dependent work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({ readiness: () => ({ _tag: "RequiresNavigation" }) });
      const session = yield* (yield* f.acquisition).connect;
      const handle = session.bind();

      // Navigation is what produces an initialized document: it is never gated.
      yield* handle.navigate("https://example.test/next");
      yield* session.pages;

      const dependents: ReadonlyArray<Effect.Effect<unknown, BrowserError>> = [
        handle.readText(),
        handle.click("#action"),
        session.observe(),
        handle.screenshot(false),
      ];

      for (const dependent of dependents) {
        const result = yield* dependent.pipe(Effect.result);

        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.reason, "stale");
          assert.equal(result.failure.outcome, "undispatched");
        }
      }
      assert.equal(f.state.clicks, 0);
      assert.equal(f.state.readinessChecks, 4);
      assert.deepEqual(yield* session.readiness, { _tag: "RequiresNavigation" });
      yield* session.close;
    }),
  ),
);

it.effect("an unmet readiness deadline stops dependent work without a dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({
        readiness: () => ({ _tag: "NotReady", step: "settings", reason: "timeout" }),
      });

      const session = yield* (yield* f.acquisition).connect;
      const failed = yield* session.bind().click("#action").pipe(Effect.result);

      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") {
        assert.equal(failed.failure.reason, "timeout");
        assert.equal(failed.failure.outcome, "undispatched");
      }
      assert.equal(f.state.clicks, 0);
      yield* session.close;
    }),
  ),
);
