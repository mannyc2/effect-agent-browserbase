import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NavigateRequest, Observation, ObservedElement } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser, type BrowserbaseSession } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";
import { decodePng } from "../fixtures/Png.ts";

const Activity = Schema.Struct({
  clicks: Schema.Natural,
  fills: Schema.Natural,
  focused: Schema.String,
});

const read = (page: Page) =>
  Effect.promise<unknown>(() => page.evaluate("window.read()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Activity)),
  );

/** The exact node an observation named, by the label a person would read. */
const named = <E>(session: BrowserbaseSession<E>, label: string, scope?: "viewport") =>
  Effect.gen(function* () {
    const observation = yield* session.observe(scope === undefined ? {} : { scope });
    const control = observation.controls.find((candidate) => candidate.label === label);

    assert.ok(control, `no control labelled ${label}`);

    return ObservedElement.make({
      observationId: observation.observationId,
      elementId: control.elementId,
    });
  });

const refused = <A, R>(
  effect: Effect.Effect<A, BrowserError, R>,
  reason: BrowserError["reason"]["_tag"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason._tag).toBe(reason);
        // Every refusal here happens before anything is sent to the page.
        expect(result.failure.outcome).toBe("undispatched");
      }
    }),
  );

it.live("real CDP: a viewport reading holds only what is on screen and says what it left out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const secretValue = yield* Effect.promise(() => native.locator("#pass").inputValue());

          expect(secretValue).toBe("preexisting-value");
          const viewport = yield* session.observe({ scope: "viewport" });

          expect(viewport.scope).toBe("viewport");
          expect(viewport.text).toContain("visible paragraph");
          // Below the fold, behind an opaque element, and under one that takes no pointer
          // events. Hit-testing sees through the last, so it is uncertain rather than visible.
          for (const hidden of ["far below words", "covered words", "ghosted words"])
            expect(viewport.text, hidden).not.toContain(hidden);
          expect(viewport.viewport.coveredText).toBeGreaterThan(0);
          expect(viewport.viewport.uncertainText).toBeGreaterThan(0);
          // One text node of twenty lines starts at 400px of a 480px viewport: its first lines
          // are evidence, its last are not, and the node is not copied whole for one line.
          expect(viewport.text).toContain("line 0");
          expect(viewport.text).not.toContain("line 19");
          expect(viewport.viewport.clippedText).toBeGreaterThan(0);
          expect(viewport.viewport.exhausted).toBe(false);
          expect(viewport.controls.map((control) => control.label)).toEqual([
            "Relative link",
            "User",
            "Secret",
            "Sign in",
            "Other",
          ]);

          // The whole document remains a separate, explicit choice.
          const document = yield* session.observe();

          expect(document.scope).toBe("document");
          expect(document.text).toContain("far below words");
          expect(document.text).toContain("line 19");
          expect(document.controls.map((control) => control.label)).toContain("Far link");

          // What a model is shown never carries a destination, a form target or a token.
          for (const observation of [viewport, document]) {
            const shown = Schema.encodeSync(Schema.fromJsonString(Observation))(observation);

            expect(
              observation.controls.find((control) => control.label === "Secret")?.inputType,
            ).toBe("password");
            for (const secret of ["token=secret", "/submit", "/other", secretValue])
              expect(shown, secret).not.toContain(secret);
          }
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: a host reads current facts from the exact node and can refuse before input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
            const [native] = f.nativePages(session.reference.sessionId);

            assert.ok(native);
            const origin = new URL(f.url).origin;
            const link = yield* session.controlFacts(yield* named(session, "Relative link"));

            // Resolved by the browser against <base href="/base/">, token and all: host-only.
            expect(link.destination).toBe(`${origin}/base/next?token=secret`);
            expect(link.kind).toBe("link");
            expect(link.placement).toBe("inside");
            expect(link.hitTest).toBe("self");
            expect(link.mainFrame).toBe(true);
            expect(link.box.y).toBe(30);

            const secret = yield* session.controlFacts(yield* named(session, "Secret"));

            expect(secret.inputType).toBe("password");
            expect(secret.autocomplete).toBe("current-password");
            expect(secret.editable).toBe(true);
            // Never a value, and never markup.
            expect(Object.keys(secret)).not.toContain("value");

            const submit = yield* session.controlFacts(yield* named(session, "Sign in"));

            expect(submit.destination).toBe(`${origin}/submit`);
            expect(submit.formMethod).toBe("post");
            // A formaction/formmethod override is the effective destination, not the form's own.
            const other = yield* session.controlFacts(yield* named(session, "Other"));

            expect(other.destination).toBe(`${origin}/other`);
            expect(other.formMethod).toBe("get");

            // The policy sees facts read just now, and a refusal sends nothing at all.
            const seen: Array<string | undefined> = [];

            yield* refused(
              session.fillElement(yield* named(session, "Secret"), "hunter2", {
                admit: (facts) => {
                  seen.push(facts.inputType);

                  return facts.inputType !== "password";
                },
              }),
              "Denied",
            );
            expect(seen).toEqual(["password"]);
            // A policy that throws fails closed.
            yield* refused(
              session.clickElement(yield* named(session, "Sign in"), {
                admit: () => {
                  throw new Error("PRIVATE-POLICY-FAILURE");
                },
              }),
              "Denied",
            );
            expect(yield* read(native)).toEqual({ clicks: 0, fills: 0, focused: "" });

            // An admitted control is acted on normally.
            yield* session.fillElement(yield* named(session, "User"), "ada", {
              admit: (facts) => facts.autocomplete === "username",
            });
            expect((yield* read(native)).fills).toBe(1);
            yield* session.close;
          }),
        );
      }),
    ),
);

it.live("real CDP: a control that changed is no longer the control that was inspected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const mutate = (script: string) => Effect.promise(() => native.evaluate(script));

          // The same attached node, pointed somewhere else.
          const link = yield* named(session, "Relative link");

          yield* mutate("document.querySelector('#rel').href = 'https://elsewhere.example/'");
          yield* refused(session.clickElement(link), "Stale");

          // The same attached node, now asking for a secret.
          const user = yield* named(session, "User");

          yield* mutate("document.querySelector('#user').type = 'password'");
          yield* refused(session.fillElement(user, "ada"), "Stale");

          // A replacement that looks identical is still not the node that was inspected, and
          // nothing is ever re-found by selector or label.
          const submit = yield* named(session, "Sign in");

          yield* mutate("go.replaceWith(go.cloneNode(true))");
          yield* refused(session.clickElement(submit), "Stale");
          expect(yield* read(native)).toEqual({ clicks: 0, fills: 0, focused: "" });
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: a checkpoint is passive, so inspect, checkpoint, then act all compose", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const user = yield* named(session, "User");
          const target = yield* session.target;
          const checkpoint = yield* session.checkpoint({ picture: true });

          expect(checkpoint.target).toEqual(target);
          expect(checkpoint.text).toContain("visible paragraph");
          expect(checkpoint.text).not.toContain("covered words");
          expect(checkpoint.documentChanged).toBe(false);
          expect(checkpoint.completedMonotonicNanos).toBeGreaterThanOrEqual(
            checkpoint.startedMonotonicNanos,
          );
          // Host-only evidence: facts, with the destination a recorder may want to caption.
          expect(
            checkpoint.controls.find((control) => control.label === "Relative link")?.destination,
          ).toContain("/base/next");
          assert.ok(checkpoint.picture);
          const picture = decodePng(checkpoint.picture.bytes);

          expect([picture.width, picture.height]).toEqual([640, 480]);
          // The opaque slab that covers the text, as painted: #333.
          expect(picture.rgb(150, 110)).toEqual([51, 51, 51]);

          // Several checkpoints later, the inspected node is still actionable and the selection
          // has not moved. `observe()` here would have retired the reference.
          yield* session.checkpoint();
          expect(yield* session.target).toEqual(target);
          yield* session.fillElement(user, "ada");
          expect((yield* read(native)).fills).toBe(1);
          yield* session.close;
        }),
      );
    }),
  ),
);

it.live("real CDP: after a hold, the exact node is checked again before it can be acted on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);
          const [page] = yield* session.pages;

          assert.ok(native);
          assert.ok(page);
          const mutate = (script: string) => Effect.promise(() => native.evaluate(script));

          // Unchanged across the hold: refused unchecked, then admitted once checked.
          const user = yield* named(session, "User");

          yield* PageControl.resume(session, yield* PageControl.suspend(session, page));
          yield* refused(session.fillElement(user, "ada"), "Stale");
          expect(yield* session.revalidateElement(user)).toEqual(user);
          yield* session.fillElement(user, "ada");
          expect((yield* read(native)).fills).toBe(1);

          // Replaced by the page's own `resume` handler: a hold is not semantically harmless.
          const submit = yield* named(session, "Sign in");

          yield* mutate("window.onResume = () => go.replaceWith(go.cloneNode(true))");
          yield* PageControl.resume(session, yield* PageControl.suspend(session, page));
          yield* refused(session.revalidateElement(submit), "Stale");
          yield* refused(session.clickElement(submit), "Stale");

          // Changed, not replaced.
          yield* mutate(
            "window.onResume = () => { document.querySelector('#rel').href = '/moved' }",
          );
          const link = yield* named(session, "Relative link");

          yield* PageControl.resume(session, yield* PageControl.suspend(session, page));
          yield* refused(session.revalidateElement(link), "Stale");

          // While held, the page is refused rather than woken to be checked or read.
          yield* mutate("window.onResume = undefined");
          const held = yield* named(session, "User");
          const receipt = yield* PageControl.suspend(session, page);

          yield* refused(session.revalidateElement(held), "Busy");
          yield* refused(session.checkpoint(), "Busy");
          yield* PageControl.resume(session, receipt);

          // Navigation ends the observation outright; there is nothing left to check.
          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport#again` }));
          yield* refused(session.revalidateElement(held), "Stale");
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);

it.live("real CDP: holding one page leaves another page's observation alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [stage] = yield* session.pages;

          assert.ok(stage);
          yield* session.selectPage(yield* session.createPage);

          yield* session.navigate(NavigateRequest.make({ url: `${f.url}viewport#scout` }));

          const native = f
            .nativePages(session.reference.sessionId)
            .find((candidate) => candidate.url().endsWith("#scout"));

          assert.ok(native);
          const user = yield* named(session, "User");
          const receipt = yield* PageControl.suspend(session, stage);

          // The stage is held for a recording while the agent keeps driving the scout.
          yield* session.fillElement(user, "ada");
          expect((yield* read(native)).fills).toBe(1);
          yield* PageControl.resume(session, receipt);
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);
