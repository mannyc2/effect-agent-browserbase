import assert from "node:assert/strict";

import { expect, it, vi } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import type { PageOperations } from "effect-browser/browser";
import { NavigateRequest, Observation, ObservedElement } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import {
  localBrowser,
  localLaunch,
  policy,
  settle,
  withProvider,
} from "../fixtures/LocalBrowser.ts";
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
const named = (page: PageOperations, label: string, scope?: "viewport") =>
  Effect.gen(function* () {
    const observation = yield* page.observe(scope === undefined ? {} : { scope });
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

          yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const secretValue = yield* Effect.promise(() => native.locator("#pass").inputValue());

          expect(secretValue).toBe("preexisting-value");
          const viewport = yield* session.initialPage.observe({ scope: "viewport" });

          expect(viewport.scope).toBe("viewport");
          expect(viewport.text).toContain("visible paragraph");
          // Below the fold, behind an opaque element, and under an opaque one that takes no
          // pointer events. The browser's own hit test finds the last painting over its words.
          for (const hidden of ["far below words", "covered words", "ghosted words"])
            expect(viewport.text, hidden).not.toContain(hidden);
          expect(viewport.viewport.coveredText).toBe(2);
          expect(viewport.viewport.uncertainText).toBe(0);
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
          const document = yield* session.initialPage.observe();

          expect(document.scope).toBe("document");
          expect(document.text).toContain("far below words");
          expect(document.text).toContain("line 19");
          expect(document.controls.map((control) => control.label)).toContain("Far link");

          // What a model is shown never carries a destination, a form target or a token.
          for (const observation of [viewport, document]) {
            const shown = yield* Schema.encodeEffect(Schema.fromJsonString(Observation))(
              observation,
            );

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

            yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
            const [native] = f.nativePages(session.reference.sessionId);

            assert.ok(native);
            const origin = new URL(f.url).origin;

            const link = yield* session.initialPage.controlFacts(
              yield* named(session.initialPage, "Relative link"),
            );

            // Resolved by the browser against <base href="/base/">, token and all: host-only.
            expect(link.destination).toBe(`${origin}/base/next?token=secret`);
            expect(link.kind).toBe("link");
            expect(link.placement).toBe("inside");
            expect(link.hitTest).toBe("self");
            expect(link.mainFrame).toBe(true);
            expect(link.box.y).toBe(30);

            const secret = yield* session.initialPage.controlFacts(
              yield* named(session.initialPage, "Secret"),
            );

            expect(secret.inputType).toBe("password");
            expect(secret.autocomplete).toBe("current-password");
            expect(secret.editable).toBe(true);
            // Never a value, and never markup.
            expect(Object.keys(secret)).not.toContain("value");

            const submit = yield* session.initialPage.controlFacts(
              yield* named(session.initialPage, "Sign in"),
            );

            expect(submit.destination).toBe(`${origin}/submit`);
            expect(submit.formMethod).toBe("post");

            // A formaction/formmethod override is the effective destination, not the form's own.
            const other = yield* session.initialPage.controlFacts(
              yield* named(session.initialPage, "Other"),
            );

            expect(other.destination).toBe(`${origin}/other`);
            expect(other.formMethod).toBe("get");

            // The policy sees facts read just now, and a refusal sends nothing at all.
            const seen: Array<string | undefined> = [];

            yield* refused(
              session.initialPage.fillElement(
                yield* named(session.initialPage, "Secret"),
                "hunter2",
                {
                  admit: (facts) => {
                    seen.push(facts.inputType);

                    return facts.inputType !== "password";
                  },
                },
              ),
              "Denied",
            );
            expect(seen).toEqual(["password"]);
            // A policy that throws fails closed.
            yield* refused(
              session.initialPage.clickElement(yield* named(session.initialPage, "Sign in"), {
                admit: () => {
                  throw new Error("PRIVATE-POLICY-FAILURE");
                },
              }),
              "Denied",
            );
            expect(yield* read(native)).toEqual({ clicks: 0, fills: 0, focused: "" });

            // An admitted control is acted on normally.
            yield* session.initialPage.fillElement(
              yield* named(session.initialPage, "User"),
              "ada",
              {
                admit: (facts) => facts.autocomplete === "username",
              },
            );
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

          yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const mutate = (script: string) => Effect.promise(() => native.evaluate(script));

          // The same attached node, pointed somewhere else.
          const link = yield* named(session.initialPage, "Relative link");

          yield* mutate("document.querySelector('#rel').href = 'https://elsewhere.example/'");
          yield* refused(session.initialPage.clickElement(link), "Stale");

          // The same attached node, now asking for a secret.
          const user = yield* named(session.initialPage, "User");

          yield* mutate("document.querySelector('#user').type = 'password'");
          yield* refused(session.initialPage.fillElement(user, "ada"), "Stale");

          // A replacement that looks identical is still not the node that was inspected, and
          // nothing is ever re-found by selector or label.
          const submit = yield* named(session.initialPage, "Sign in");

          yield* mutate("go.replaceWith(go.cloneNode(true))");
          yield* refused(session.initialPage.clickElement(submit), "Stale");
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

          yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const user = yield* named(session.initialPage, "User");
          const target = session.initialPage.identity;
          const checkpoint = yield* session.initialPage.checkpoint({ picture: true });

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
          yield* session.initialPage.checkpoint();
          expect(session.initialPage.identity).toEqual(target);
          yield* session.initialPage.fillElement(user, "ada");
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

          yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [native] = f.nativePages(session.reference.sessionId);
          const [page] = yield* session.listPages();

          assert.ok(native);
          assert.ok(page);
          const mutate = (script: string) => Effect.promise(() => native.evaluate(script));

          // Unchanged across the hold: refused unchecked, then admitted once checked.
          const user = yield* named(session.initialPage, "User");

          yield* PageControl.resume(
            session.initialPage,
            yield* PageControl.suspend(yield* session.page(page)),
          );
          yield* refused(session.initialPage.fillElement(user, "ada"), "Stale");
          expect(yield* session.initialPage.revalidateElement(user)).toEqual(user);
          yield* session.initialPage.fillElement(user, "ada");
          expect((yield* read(native)).fills).toBe(1);

          // Replaced by the page's own `resume` handler: a hold is not semantically harmless.
          const submit = yield* named(session.initialPage, "Sign in");

          yield* mutate("window.onResume = () => go.replaceWith(go.cloneNode(true))");
          yield* PageControl.resume(
            session.initialPage,
            yield* PageControl.suspend(yield* session.page(page)),
          );
          yield* refused(session.initialPage.revalidateElement(submit), "Stale");
          yield* refused(session.initialPage.clickElement(submit), "Stale");

          // Changed, not replaced.
          yield* mutate(
            "window.onResume = () => { document.querySelector('#rel').href = '/moved' }",
          );
          const link = yield* named(session.initialPage, "Relative link");

          yield* PageControl.resume(
            session.initialPage,
            yield* PageControl.suspend(yield* session.page(page)),
          );
          yield* refused(session.initialPage.revalidateElement(link), "Stale");

          // While held, the page is refused rather than woken to be checked or read.
          yield* mutate("window.onResume = undefined");
          const held = yield* named(session.initialPage, "User");
          const receipt = yield* PageControl.suspend(yield* session.page(page));

          yield* refused(session.initialPage.revalidateElement(held), "Busy");
          yield* refused(session.initialPage.checkpoint(), "Busy");
          yield* PageControl.resume(session.initialPage, receipt);

          // Navigation ends the observation outright; there is nothing left to check.
          yield* session.initialPage.navigate(
            NavigateRequest.make({ url: `${f.url}viewport#again` }),
          );
          yield* refused(session.initialPage.revalidateElement(held), "Stale");
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

          yield* session.initialPage.navigate(NavigateRequest.make({ url: `${f.url}viewport` }));
          const [stage] = yield* session.listPages();

          assert.ok(stage);
          const scoutInfo = yield* session.createPage();

          yield* session.selectPage(scoutInfo);
          const scout = yield* session.page(scoutInfo);

          yield* scout.navigate(NavigateRequest.make({ url: `${f.url}viewport#scout` }));

          const native = f
            .nativePages(session.reference.sessionId)
            .find((candidate) => candidate.url().endsWith("#scout"));

          assert.ok(native);
          const user = yield* named(scout, "User");
          const receipt = yield* PageControl.suspend(yield* session.page(stage));

          // The stage is held for a recording while the agent keeps driving the scout.
          yield* scout.fillElement(user, "ada");
          expect((yield* read(native)).fills).toBe(1);
          yield* PageControl.resume(session.initialPage, receipt);
          yield* session.close;
        }),
        { pageControl: true },
      );
    }),
  ),
);

it.live(
  "real CDP: selection excursions preserve the original exact node until its own page navigates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.initialPage.navigate({ url: `${f.url}viewport` });
            const [stage] = yield* session.listPages();
            const [nativeStage] = f.nativePages(session.reference.sessionId);

            assert.ok(stage);
            assert.ok(nativeStage);
            const scout = yield* session.createPage();
            const pinnedScout = yield* session.page(scout);

            yield* pinnedScout.navigate({ url: `${f.url}viewport#scout` });

            const nativeScout = f
              .nativePages(session.reference.sessionId)
              .find((page) => page !== nativeStage);

            assert.ok(nativeScout);
            const reference = yield* named(session.initialPage, "User");
            const retained = session.initialPage;

            yield* session.selectPage(scout);
            expect((yield* session.initialPage.readText({})).text).toContain("visible paragraph");
            yield* refused(pinnedScout.clickElement(reference), "Stale");
            expect((yield* read(nativeStage)).clicks).toBe(0);
            expect((yield* read(nativeScout)).clicks).toBe(0);
            yield* session.selectPage(stage);
            expect((yield* retained.readText({})).text).toContain("visible paragraph");

            // No new observe occurs between naming this node and acting on it.
            expect((yield* pinnedScout.readText({})).text).toContain("visible paragraph");
            yield* pinnedScout.navigate({ url: `${f.url}viewport?scout=updated` });
            yield* pinnedScout.click({ selector: "#user" });
            const unrelated = yield* session.createPage();

            yield* (yield* session.page(unrelated)).close();
            expect((yield* session.initialPage.controlFacts(reference)).label).toBe("User");
            yield* session.initialPage.clickElement(reference);
            expect((yield* read(nativeStage)).clicks).toBe(1);
            expect((yield* read(nativeScout)).clicks).toBe(1);
            expect(session.initialPage.identity.pageId).toBe(stage.pageId);

            const beforeNavigation = yield* named(session.initialPage, "User");
            const pinnedStage = yield* session.page(stage);

            yield* session.selectPage(scout);
            yield* pinnedStage.navigate({ url: `${f.url}viewport?stage=replaced` });
            yield* session.selectPage(stage);
            yield* refused(session.initialPage.clickElement(beforeNavigation), "Stale");
            expect((yield* read(nativeStage)).clicks).toBe(0);
            yield* session.initialPage.clickElement(yield* named(session.initialPage, "User"));
            expect((yield* read(nativeStage)).clicks).toBe(1);
          }),
        );
      }),
    ),
);

it.live("real CDP: returning to a page never authorizes a replacement or changed control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);

          yield* session.initialPage.navigate({ url: `${f.url}viewport` });
          const [stage] = yield* session.listPages();
          const [nativeStage] = f.nativePages(session.reference.sessionId);

          assert.ok(stage);
          assert.ok(nativeStage);
          const scout = yield* session.createPage();
          const replaced = yield* named(session.initialPage, "User");

          yield* session.selectPage(scout);
          yield* Effect.promise(() =>
            nativeStage.locator("#user").evaluate((node) => {
              node.replaceWith(node.cloneNode(true));
            }),
          );
          yield* session.selectPage(stage);
          yield* refused(session.initialPage.clickElement(replaced), "Stale");

          const changed = yield* named(session.initialPage, "User");

          yield* session.selectPage(scout);
          yield* Effect.promise(() =>
            nativeStage.locator("#user").evaluate((node) => {
              (node as HTMLInputElement).required = true;
            }),
          );
          yield* session.selectPage(stage);
          yield* refused(session.initialPage.fillElement(changed, "must not arrive"), "Stale");
          expect(yield* read(nativeStage)).toEqual({ clicks: 0, fills: 0, focused: "" });
        }),
      );
    }),
  ),
);

it.live(
  "real CDP: a retained observation checks its frame and retires on background document replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.initialPage.navigate({ url: f.url });
            const [page] = yield* session.listPages();

            assert.ok(page);

            const frames = yield* settle(session.initialPage.listFrames(), (frames) =>
              frames.some((frame) => frame.name === "child" && frame.url.endsWith("/frame")),
            );

            const child = frames.find(
              (frame) => frame.name === "child" && frame.url.endsWith("/frame"),
            );

            const main = frames.find((frame) => frame.parentFrameId === null);

            assert.ok(child);
            assert.ok(main);
            const childAuthority = yield* session.initialPage.frame(child);
            const reference = yield* named(childAuthority, "Frame action");

            yield* refused(session.initialPage.clickElement(reference), "Stale");
            expect((yield* childAuthority.readText({ selector: "#inner" })).text).toBe(
              "Frame action",
            );
            yield* childAuthority.clickElement(reference);
            expect((yield* childAuthority.readText({ selector: "#inner" })).text).toBe(
              "frame clicked",
            );

            const oldDocument = yield* named(childAuthority, "frame clicked");
            const pinnedChild = yield* (yield* session.page(page)).frame(child);

            yield* pinnedChild.navigate({ url: `${f.url}frame` });
            yield* refused(childAuthority.clickElement(oldDocument), "Stale");
            expect((yield* childAuthority.readText({ selector: "#inner" })).text).toBe(
              "Frame action",
            );

            // Adoption preserves node identity and attachment but changes the owning document.
            const adopted = yield* named(childAuthority, "Frame action");
            const [native] = f.nativePages(session.reference.sessionId);
            const nativeChild = native?.frames().find((frame) => frame.name() === "child");

            assert.ok(native);
            assert.ok(nativeChild);

            const moved = yield* Effect.promise(() =>
              nativeChild.evaluate(() => {
                const node = document.querySelector("#inner");

                if (node === null) throw new Error("Missing frame control");
                parent.document.body.append(node);

                return {
                  connected: node.isConnected,
                  sameDocument: node.ownerDocument === document,
                };
              }),
            );

            expect(moved).toEqual({ connected: true, sameDocument: false });
            yield* refused(session.initialPage.clickElement(adopted), "Stale");
            expect(yield* Effect.promise(() => native.locator("#inner").textContent())).toBe(
              "Frame action",
            );
          }),
        );
      }),
    ),
);

it.live("real CDP: same-page pointer input still requires a new observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);

          yield* session.initialPage.navigate({ url: `${f.url}viewport` });
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const superseded = yield* named(session.initialPage, "User");
          const current = yield* named(session.initialPage, "User");

          yield* refused(session.initialPage.clickElement(superseded), "Stale");
          expect((yield* session.initialPage.controlFacts(current)).label).toBe("User");
          for (const input of [
            session.initialPage.hover({ selector: "#user" }),
            session.initialPage.pointerMove({ to: { x: 20, y: 185 } }),
            session.initialPage.wheel({ deltaX: 0, deltaY: 1 }),
            session.initialPage.scroll({ deltaX: 0, deltaY: 1 }),
          ]) {
            const reference = yield* named(session.initialPage, "User");

            yield* input;
            yield* refused(session.initialPage.clickElement(reference), "Stale");
          }
          expect((yield* read(native)).clicks).toBe(0);
          yield* session.initialPage.clickElement(yield* named(session.initialPage, "User"));
          expect((yield* read(native)).clicks).toBe(1);
        }),
      );
    }),
  ),
);

it.live("real CDP: reconnect cannot substitute a new node for an old observation reference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* BrowserbaseBrowser.open(policy);

          yield* session.initialPage.navigate({ url: `${f.url}viewport` });
          const reference = yield* named(session.initialPage, "User");

          yield* session.detach;
          const inventory = yield* session.reconnect(true);
          const [info] = inventory.pages;

          assert.ok(info !== undefined);
          const page = yield* session.page(info);
          const fresh = yield* page.observe();
          const control = fresh.controls.find((control) => control.label === "User");

          assert.ok(control);
          expect(control.elementId).toBe(reference.elementId);
          expect(fresh.observationId).not.toBe(reference.observationId);
          yield* refused(session.initialPage.clickElement(reference), "Stale");
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          expect((yield* read(native)).clicks).toBe(0);
          yield* page.clickElement({
            observationId: fresh.observationId,
            elementId: control.elementId,
          });
          expect((yield* read(native)).clicks).toBe(1);
          expect(f.connections).toEqual(["session-1", "session-1"]);
        }),
        { launch: { ...localLaunch, keepAlive: true } },
      );
      expect(f.releaseIds).toEqual(["session-1"]);
    }),
  ),
);

it.live(
  "real CDP: cancellation during node extraction releases the late handle and preserves a fresh observation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.initialPage.navigate({ url: `${f.url}viewport` });
            const [native] = f.nativePages(session.reference.sessionId);

            assert.ok(native);
            const frame = native.mainFrame();
            const evaluateHandle = frame.evaluateHandle.bind(frame);
            const entered = yield* Deferred.make<void>();
            const disposed = yield* Deferred.make<void>();
            let resume: () => void = () => {};

            const extraction = new Promise<void>((resolve) => {
              resume = resolve;
            });

            const restore: Array<() => void> = [];
            let releases = 0;

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                resume();
                for (const reset of restore.reverse()) reset();
              }),
            );

            // Delay the real node handles after Chromium has returned them. All extraction,
            // cancellation, retirement and the succeeding action run through the public session.
            const evaluate = vi.spyOn(frame, "evaluateHandle");

            restore.push(() => evaluate.mockRestore());
            evaluate.mockImplementationOnce(async (...args) => {
              const holder = await evaluateHandle(...args);
              const select = holder.evaluateHandle.bind(holder);
              const selected = vi.spyOn(holder, "evaluateHandle");

              restore.push(() => selected.mockRestore());
              selected.mockImplementationOnce(async (...selectArgs) => {
                const property = await select(...selectArgs);
                const getProperties = property.getProperties.bind(property);
                const nodes = vi.spyOn(property, "getProperties");

                restore.push(() => nodes.mockRestore());
                nodes.mockImplementationOnce(async () => {
                  const all = await getProperties();
                  const node = all.get("0");

                  assert.ok(node);
                  const dispose = node.dispose.bind(node);
                  const release = vi.spyOn(node, "dispose");

                  restore.push(() => release.mockRestore());
                  release.mockImplementation(async () => {
                    releases++;
                    await dispose();
                    Deferred.doneUnsafe(disposed, Effect.void);
                  });
                  Deferred.doneUnsafe(entered, Effect.void);
                  await extraction;

                  return all;
                });

                return property;
              });

              return holder;
            });

            const pending = yield* session.initialPage.observe().pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            yield* Fiber.interrupt(pending);
            // The interrupted read can no longer change the page, so the page is usable at once.
            const observation = yield* session.initialPage.observe();

            expect(releases).toBe(0);
            resume();

            const control = observation.controls.find((candidate) => candidate.label === "User");

            assert.ok(control, "no control labelled User");

            const fresh = ObservedElement.make({
              observationId: observation.observationId,
              elementId: control.elementId,
            });

            yield* Deferred.await(disposed);
            expect(releases).toBe(1);
            expect((yield* session.initialPage.controlFacts(fresh)).label).toBe("User");
            expect((yield* read(native)).clicks).toBe(0);
            yield* session.initialPage.clickElement(fresh);
            expect((yield* read(native)).clicks).toBe(1);
          }),
        );
      }),
    ),
);
