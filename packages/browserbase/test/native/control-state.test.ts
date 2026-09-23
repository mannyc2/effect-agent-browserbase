import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Observation, ObservedElement } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";

import { localBrowser, policy, withProvider } from "../fixtures/LocalBrowser.ts";

it.live(
  "native and ARIA control states are bounded, value-free, and rechecked on the exact node",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const session = yield* BrowserbaseBrowser.open(policy);

            yield* session.navigate({ url: fixture.url });
            const [page] = fixture.nativePages(session.reference.sessionId);

            assert.ok(page);
            yield* Effect.promise(() =>
              page.setContent(`<!doctype html><title>Control states</title>
        <input id=check aria-label="Native checkbox" type=checkbox checked value="FIELD-SECRET" onclick="window.clicks++">
        <input aria-label="Native radio" type=radio>
        <input aria-label="Password field" type=password required value="PASSWORD-SECRET">
        <input aria-label="Hidden field" type=hidden required value="HIDDEN-SECRET">
        <div role=checkbox aria-label="ARIA checked" aria-checked=true></div>
        <div role=checkbox aria-label="ARIA mixed" aria-checked=mixed></div>
        <div role=checkbox aria-label="ARIA invalid" aria-checked=perhaps></div>
        <div role=option aria-label="ARIA selected" aria-selected=true></div>
        <div role=textbox aria-label="ARIA required" aria-required=true></div>
        <button aria-label="Ordinary button" aria-required=true>Button</button>
        <select id=choices aria-label="Native select" required aria-selected=true>
          <option id=chosen selected value="OPTION-SECRET">Native option</option>
          <option value="OTHER-SECRET">Other option</option>
        </select>
        <select aria-label="Multiple select" multiple>
          <option selected>First selected</option><option selected>Second selected</option>
        </select>
        <script>window.clicks=0</script>`),
            );

            const observation = yield* session.observe({ maxControls: 32 });

            const named = (label: string) => {
              const found = observation.controls.find((control) => control.label === label);

              assert.ok(found, label);

              return found;
            };

            expect(named("Native checkbox")).toMatchObject({
              inputType: "checkbox",
              checked: true,
              required: false,
            });
            expect(named("Native radio")).toMatchObject({ inputType: "radio", checked: false });
            expect(named("Password field")).toMatchObject({
              inputType: "password",
              required: true,
            });
            expect(named("Hidden field").required).toBeUndefined();
            expect(named("ARIA checked").checked).toBe(true);
            expect(named("ARIA mixed").checked).toBeUndefined();
            expect(named("ARIA invalid").checked).toBeUndefined();
            expect(named("ARIA selected").selected).toBe(true);
            expect(named("ARIA required").required).toBe(true);
            expect(named("Ordinary button").required).toBeUndefined();
            expect(named("Native select").selected).toBeUndefined();
            expect(named("Native select").required).toBe(true);
            for (const label of ["Native option", "First selected", "Second selected"])
              expect(named(label).selected).toBe(true);
            expect(named("Other option").selected).toBe(false);

            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Observation))(
              observation,
            );

            for (const value of [
              "FIELD-SECRET",
              "PASSWORD-SECRET",
              "HIDDEN-SECRET",
              "OPTION-SECRET",
              "OTHER-SECRET",
            ])
              expect(encoded).not.toContain(value);
            for (const control of observation.controls) {
              expect(Object.keys(control)).not.toContain("value");
              expect(Object.keys(control)).not.toContain("destination");
            }

            const checkbox = ObservedElement.make({
              observationId: observation.observationId,
              elementId: named("Native checkbox").elementId,
            });

            yield* Effect.promise(() =>
              page.locator("#check").evaluate((node) => {
                (node as HTMLInputElement).checked = false;
              }),
            );
            expect(yield* session.clickElement(checkbox).pipe(Effect.flip)).toMatchObject({
              reason: { _tag: "Stale" },
              outcome: "undispatched",
            });
            expect(yield* Effect.promise(() => page.evaluate("window.clicks"))).toBe(0);

            const fresh = yield* session.observe({ maxControls: 32 });
            const option = fresh.controls.find((control) => control.label === "Native option")!;
            const select = fresh.controls.find((control) => control.label === "Native select")!;

            yield* Effect.promise(() =>
              page.locator("#choices").evaluate((node) => {
                const element = node as HTMLSelectElement;

                element.selectedIndex = 1;
                element.required = false;
              }),
            );
            for (const control of [option, select]) {
              expect(
                yield* session
                  .controlFacts({
                    observationId: fresh.observationId,
                    elementId: control.elementId,
                  })
                  .pipe(Effect.flip),
              ).toMatchObject({ reason: { _tag: "Stale" }, outcome: "undispatched" });
            }
          }),
        );
      }),
    ),
);
