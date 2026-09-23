import assert from "node:assert/strict";

import { expect, it, vi } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { NavigateRequest, Observation, ObservedElement } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser, type BrowserbaseSession } from "effect-browserbase/browser";
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

            yield* session.navigate({ url: `${f.url}viewport` });
            const [stage] = yield* session.pages;
            const [nativeStage] = f.nativePages(session.reference.sessionId);

            assert.ok(stage);
            assert.ok(nativeStage);
            const scout = yield* session.createPage;
            const pinnedScout = yield* session.pinPage(scout);

            yield* pinnedScout.navigate({ url: `${f.url}viewport#scout` });

            const nativeScout = f
              .nativePages(session.reference.sessionId)
              .find((page) => page !== nativeStage);

            assert.ok(nativeScout);
            const reference = yield* named(session, "User");
            const retained = yield* session.retain;

            yield* session.selectPage(scout);
            expect((yield* session.readText({})).text).toContain("visible paragraph");
            yield* refused(session.clickElement(reference), "Stale");
            expect((yield* read(nativeStage)).clicks).toBe(0);
            expect((yield* read(nativeScout)).clicks).toBe(0);
            yield* session.selectPage(stage);
            yield* refused(retained.readText({}), "Stale");

            // No new observe occurs between naming this node and acting on it.
            expect((yield* pinnedScout.readText({})).text).toContain("visible paragraph");
            yield* pinnedScout.navigate({ url: `${f.url}viewport?scout=updated` });
            yield* pinnedScout.click({ selector: "#user" });
            const unrelated = yield* session.createPage;

            yield* session.closePage(unrelated);
            expect((yield* session.controlFacts(reference)).label).toBe("User");
            yield* session.clickElement(reference);
            expect((yield* read(nativeStage)).clicks).toBe(1);
            expect((yield* read(nativeScout)).clicks).toBe(1);
            expect((yield* session.target).pageId).toBe(stage.pageId);

            const beforeNavigation = yield* named(session, "User");
            const pinnedStage = yield* session.pinPage(stage);

            yield* session.selectPage(scout);
            yield* pinnedStage.navigate({ url: `${f.url}viewport?stage=replaced` });
            yield* session.selectPage(stage);
            yield* refused(session.clickElement(beforeNavigation), "Stale");
            expect((yield* read(nativeStage)).clicks).toBe(0);
            yield* session.clickElement(yield* named(session, "User"));
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

          yield* session.navigate({ url: `${f.url}viewport` });
          const [stage] = yield* session.pages;
          const [nativeStage] = f.nativePages(session.reference.sessionId);

          assert.ok(stage);
          assert.ok(nativeStage);
          const scout = yield* session.createPage;
          const replaced = yield* named(session, "User");

          yield* session.selectPage(scout);
          yield* Effect.promise(() =>
            nativeStage.locator("#user").evaluate((node) => {
              node.replaceWith(node.cloneNode(true));
            }),
          );
          yield* session.selectPage(stage);
          yield* refused(session.clickElement(replaced), "Stale");

          const changed = yield* named(session, "User");

          yield* session.selectPage(scout);
          yield* Effect.promise(() =>
            nativeStage.locator("#user").evaluate((node) => {
              (node as HTMLInputElement).required = true;
            }),
          );
          yield* session.selectPage(stage);
          yield* refused(session.fillElement(changed, "must not arrive"), "Stale");
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

            yield* session.navigate({ url: f.url });
            const [page] = yield* session.pages;

            assert.ok(page);

            const frames = yield* settle(session.frames, (frames) =>
              frames.some((frame) => frame.name === "child" && frame.url.endsWith("/frame")),
            );

            const child = frames.find(
              (frame) => frame.name === "child" && frame.url.endsWith("/frame"),
            );

            const main = frames.find((frame) => frame.parentFrameId === null);

            assert.ok(child);
            assert.ok(main);
            yield* session.selectFrame(child.frameId);
            const reference = yield* named(session, "Frame action");

            yield* session.selectFrame(main.frameId);
            yield* refused(session.clickElement(reference), "Stale");
            yield* session.selectFrame(child.frameId);
            expect((yield* session.readText({ selector: "#inner" })).text).toBe("Frame action");
            yield* session.clickElement(reference);
            expect((yield* session.readText({ selector: "#inner" })).text).toBe("frame clicked");

            const oldDocument = yield* named(session, "frame clicked");
            const pinnedChild = yield* session.pinFrame(page, child);

            yield* session.selectFrame(main.frameId);
            yield* pinnedChild.navigate({ url: `${f.url}frame` });
            yield* session.selectFrame(child.frameId);
            yield* refused(session.clickElement(oldDocument), "Stale");
            expect((yield* session.readText({ selector: "#inner" })).text).toBe("Frame action");

            // Adoption preserves node identity and attachment but changes the owning document.
            const adopted = yield* named(session, "Frame action");
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
            yield* refused(session.clickElement(adopted), "Stale");
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

          yield* session.navigate({ url: `${f.url}viewport` });
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          const superseded = yield* named(session, "User");
          const current = yield* named(session, "User");

          yield* refused(session.clickElement(superseded), "Stale");
          expect((yield* session.controlFacts(current)).label).toBe("User");
          for (const input of [
            session.hover({ selector: "#user" }),
            session.pointerMove({ to: { x: 20, y: 185 } }),
            session.wheel({ deltaX: 0, deltaY: 1 }),
            session.scroll({ deltaX: 0, deltaY: 1 }),
          ]) {
            const reference = yield* named(session, "User");

            yield* input;
            yield* refused(session.clickElement(reference), "Stale");
          }
          expect((yield* read(native)).clicks).toBe(0);
          yield* session.clickElement(yield* named(session, "User"));
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

          yield* session.navigate({ url: `${f.url}viewport` });
          const reference = yield* named(session, "User");

          yield* session.detach;
          const fresh = yield* session.reconnect(true);
          const control = fresh.controls.find((control) => control.label === "User");

          assert.ok(control);
          expect(control.elementId).toBe(reference.elementId);
          expect(fresh.observationId).not.toBe(reference.observationId);
          yield* refused(session.clickElement(reference), "Stale");
          const [native] = f.nativePages(session.reference.sessionId);

          assert.ok(native);
          expect((yield* read(native)).clicks).toBe(0);
          yield* session.clickElement({
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

            yield* session.navigate({ url: `${f.url}viewport` });
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

            // Delay only the first real node handle after Chromium has returned it. All extraction,
            // cancellation, retirement and the succeeding action run through the public session.
            const evaluate = vi.spyOn(frame, "evaluateHandle");

            restore.push(() => evaluate.mockRestore());
            evaluate.mockImplementationOnce(async (...args) => {
              const holder = await evaluateHandle(...args);
              const getProperty = holder.getProperty.bind(holder);
              const properties = vi.spyOn(holder, "getProperty");

              restore.push(() => properties.mockRestore());
              properties.mockImplementation(async (key) => {
                const property = await getProperty(key);

                if (key === "nodes") {
                  const getNode = property.getProperty.bind(property);
                  const nodes = vi.spyOn(property, "getProperty");

                  restore.push(() => nodes.mockRestore());
                  nodes.mockImplementationOnce(async (index) => {
                    const node = await getNode(index);
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

                    return node;
                  });
                }

                return property;
              });

              return holder;
            });

            const pending = yield* session.observe().pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            yield* Fiber.interrupt(pending);
            const fresh = yield* named(session, "User");

            resume();
            yield* Deferred.await(disposed);
            expect(releases).toBe(1);
            expect((yield* session.controlFacts(fresh)).label).toBe("User");
            expect((yield* read(native)).clicks).toBe(0);
            yield* session.clickElement(fresh);
            expect((yield* read(native)).clicks).toBe(1);
          }),
        );
      }),
    ),
);
