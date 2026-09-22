import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import {
  BrowserPolicy,
  type Observation,
  type ObservedControl,
  ObservedElement,
} from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import * as PageControl from "effect-browser/page-control";
import { chromium } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const events = `<output id=events></output><script>
for(const type of ['input','change']) document.addEventListener(type,event=>{
  if(event.target instanceof HTMLSelectElement)
    document.querySelector('#events').textContent+=type+':'+event.target.id+';';
});
</script>`;

const content = `<!doctype html><title>Exact selections</title>
<style>select{display:block;margin:12px;width:220px}fieldset{border:0}</style>
<form action="https://example.test/PRIVATE-DESTINATION" method=post><fieldset id=field>
  <select id=single aria-label="Single choice">
    <option id=initial value="PRIVATE-INITIAL" selected>Initial</option>
    <option id=first value="PRIVATE-FIRST">Duplicate</option>
    <option id=second value="PRIVATE-SECOND">Duplicate</option>
    <optgroup id=group label="Group"><option id=grouped value="PRIVATE-GROUPED">Grouped</option></optgroup>
    <option id=disabled value="PRIVATE-DISABLED" disabled>Unavailable</option>
  </select>
  <select id=multi aria-label="Multiple choices" multiple>
    <option id=m1 value="PRIVATE-M1" selected>First</option>
    <option id=m2 value="PRIVATE-M2">Second</option>
    <option id=m3 value="PRIVATE-M3">Third</option>
  </select>
  <select id=other aria-label="Other select"><option id=foreign value="PRIVATE-FOREIGN">Foreign</option></select>
  <button aria-label="Ordinary button">Ordinary</button>
</fieldset></form>${events}`;

const fixture = Effect.fnUntraced(function* () {
  const site = yield* localSite;
  const host = yield* externalChromium;

  const observer = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.connectOverCDP(Redacted.value(host.endpoint))),
    (browser) => Effect.promise(() => browser.close()),
  );

  const session = yield* (yield* Chromium).attach(host.endpoint, {
    policy: BrowserPolicy.unrestricted({ maxActions: 250, maxElapsedMillis: 60000 }),
  });

  yield* session.navigate({ url: site.url });
  const page = observer.contexts()[0]?.pages()[0];

  assert.ok(page);
  yield* Effect.promise(() => page.setContent(content));

  return { session, page };
});

const named = (observation: Observation, label: string) => {
  const control = observation.controls.find((control) => control.label === label);

  assert.ok(control, label);

  return control;
};

const reference = (observation: Observation, control: ObservedControl) =>
  ObservedElement.make({ observationId: observation.observationId, elementId: control.elementId });

const layer = Chromium.layer({ pageControl: true, viewport: { width: 640, height: 480 } });

it.live(
  "exact option IDs distinguish duplicate labels and set one single or multiple selection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const observed = yield* session.observe({ scope: "viewport", maxControls: 64 });
        const select = named(observed, "Single choice");
        const target = reference(observed, select);

        const duplicates = observed.controls.filter(
          (control) =>
            control.selectElementId === select.elementId && control.label === "Duplicate",
        );

        expect(select).toMatchObject({ multiple: false, optionsTruncated: false });
        expect(select.selected).toBeUndefined();
        expect(duplicates).toHaveLength(2);
        expect(duplicates.every((option) => option.selected === false)).toBe(true);
        expect(JSON.stringify(observed)).not.toContain("PRIVATE-");
        const checkpoint = yield* session.checkpoint();

        expect(checkpoint).not.toHaveProperty("selects");
        expect(JSON.stringify(checkpoint.controls)).not.toContain("PRIVATE-FIRST");
        for (const facts of checkpoint.controls) expect(facts).not.toHaveProperty("value");
        for (const optionId of [
          "Duplicate",
          "PRIVATE-SECOND",
          named(observed, "Foreign").elementId,
        ])
          expect(yield* Effect.result(session.selectOption(target, [optionId]))).toMatchObject({
            _tag: "Failure",
            failure: {
              operation: "select-option",
              reason: { _tag: "Stale" },
              outcome: "undispatched",
            },
          });
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe("");

        const result = yield* session.selectOption(target, [duplicates[1]!.elementId]);

        expect(Object.keys(result)).toEqual(["url"]);
        expect(JSON.stringify(result)).not.toContain("PRIVATE-");
        expect(
          yield* Effect.promise(() =>
            page.evaluate(() =>
              [...document.querySelector<HTMLSelectElement>("#single")!.selectedOptions].map(
                (option) => option.id,
              ),
            ),
          ),
        ).toEqual(["second"]);
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe(
          "input:single;change:single;",
        );
        expect(
          yield* Effect.result(session.selectOption(target, [duplicates[0]!.elementId])),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });

        const fresh = yield* session.observe({ scope: "viewport", maxControls: 64 });
        const multiple = named(fresh, "Multiple choices");

        expect(multiple).toMatchObject({ multiple: true, optionsTruncated: false });
        yield* session.selectOption(reference(fresh, multiple), [
          named(fresh, "Third").elementId,
          named(fresh, "First").elementId,
        ]);
        expect(
          yield* Effect.promise(() =>
            page.evaluate(() =>
              [...document.querySelector<HTMLSelectElement>("#multi")!.selectedOptions].map(
                (option) => option.id,
              ),
            ),
          ),
        ).toEqual(["m1", "m3"]);
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe(
          "input:single;change:single;input:multi;change:multi;",
        );
        expect((yield* session.status).phase).toBe("open");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "replaced, moved or changed select options are refused without sending native selection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();

        for (const change of [
          "replace-select",
          "replace-option",
          "move-option",
          "value",
          "label",
          "selected",
          "option-disabled",
          "group-disabled",
          "select-disabled",
          "fieldset-disabled",
          "multiple",
        ] as const) {
          yield* Effect.promise(() => page.setContent(content));
          const observed = yield* session.observe({ maxControls: 64 });
          const select = named(observed, "Single choice");

          const option =
            change === "group-disabled"
              ? named(observed, "Grouped")
              : observed.controls.filter((control) => control.label === "Duplicate")[1]!;

          yield* Effect.promise(() =>
            page.evaluate((change) => {
              const select = document.querySelector<HTMLSelectElement>("#single")!;
              const option = document.querySelector<HTMLOptionElement>("#second")!;

              switch (change) {
                case "replace-select":
                  select.replaceWith(select.cloneNode(true));
                  break;
                case "replace-option":
                  option.replaceWith(option.cloneNode(true));
                  break;
                case "move-option":
                  document.querySelector("#other")!.appendChild(option);
                  break;
                case "value":
                  option.value = "CHANGED-PRIVATE-VALUE";
                  break;
                case "label":
                  option.label = "Changed label";
                  break;
                case "selected":
                  option.selected = true;
                  break;
                case "option-disabled":
                  option.disabled = true;
                  break;
                case "group-disabled":
                  document.querySelector<HTMLOptGroupElement>("#group")!.disabled = true;
                  break;
                case "select-disabled":
                  select.disabled = true;
                  break;
                case "fieldset-disabled":
                  document.querySelector<HTMLFieldSetElement>("#field")!.disabled = true;
                  break;
                case "multiple":
                  select.multiple = true;
                  break;
              }
            }, change),
          );
          expect(
            yield* Effect.result(
              session.selectOption(reference(observed, select), [option.elementId]),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: {
              operation: "select-option",
              reason: { _tag: "Stale" },
              outcome: "undispatched",
            },
          });
          expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe("");
          expect((yield* session.status).phase).toBe("open");
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "selection enforces disabled/admission/multiple rules and shares the bounded observation pool",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const observed = yield* session.observe({ maxControls: 64 });
        const select = named(observed, "Single choice");
        const target = reference(observed, select);

        const options = observed.controls
          .filter((control) => control.label === "Duplicate")
          .map((option) => option.elementId);

        expect(
          yield* Effect.result(
            session.selectOption(target, [named(observed, "Unavailable").elementId]),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Disabled" }, outcome: "undispatched" },
        });
        expect(yield* Effect.result(session.selectOption(target, options))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Unsupported" }, outcome: "undispatched" },
        });
        expect(
          yield* Effect.result(
            session.selectOption(reference(observed, named(observed, "Ordinary button")), [
              options[0]!,
            ]),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Unsupported" }, outcome: "undispatched" },
        });
        for (const throws of [false, true])
          expect(
            yield* Effect.result(
              session.selectOption(target, [options[0]!], {
                admit: (facts) => {
                  expect(facts.multiple).toBe(false);
                  expect(facts).not.toHaveProperty("value");
                  if (throws) throw new Error("PRIVATE-POLICY-FAILURE");

                  return false;
                },
              }),
            ),
          ).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Denied" }, outcome: "undispatched" },
          });
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe("");

        yield* Effect.promise(() =>
          page.locator("#single").evaluate((node) => {
            if (node instanceof HTMLSelectElement) node.disabled = true;
          }),
        );
        const disabled = yield* session.observe({ maxControls: 64 });

        expect(
          yield* Effect.result(
            session.selectOption(reference(disabled, named(disabled, "Single choice")), [
              named(disabled, "Initial").elementId,
            ]),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Disabled" }, outcome: "undispatched" },
        });

        yield* Effect.promise(() =>
          page.setContent(`<!doctype html><select id=many aria-label=Many>
        ${Array.from({ length: 70 }, (_, i) => `<option id=r${i} value=PRIVATE-${i}>Choice ${i}</option>`).join("")}
        </select>${events}`),
        );
        const bounded = yield* session.observe({ scope: "viewport", maxControls: 4 });
        const many = named(bounded, "Many");

        expect(bounded.controls).toHaveLength(4);
        expect(bounded.controlsTruncated).toBe(true);
        expect(many.optionsTruncated).toBe(true);
        expect(
          bounded.controls.filter((option) => option.selectElementId === many.elementId),
        ).toHaveLength(3);
        expect(
          yield* Effect.result(session.selectOption(reference(bounded, many), ["element-64"])),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        yield* session.selectOption(reference(bounded, many), [
          named(bounded, "Choice 2").elementId,
        ]);
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe(
          "input:many;change:many;",
        );
        const maximum = yield* session.observe({ scope: "viewport", maxControls: 64 });

        expect(maximum.controls).toHaveLength(64);
        expect(named(maximum, "Many").optionsTruncated).toBe(true);

        yield* Effect.promise(() =>
          page.locator("#r1").evaluate((node) => {
            if (node instanceof HTMLOptionElement) node.value = "x".repeat(65537);
          }),
        );
        const limitedValue = yield* session.observe({ scope: "viewport", maxControls: 4 });
        const unavailable = named(limitedValue, "Choice 1");

        expect(unavailable.selectElementId).toBeUndefined();
        expect(named(limitedValue, "Many").optionsTruncated).toBe(true);
        expect(JSON.stringify(limitedValue)).not.toContain("PRIVATE-");
        expect(JSON.stringify(limitedValue).length).toBeLessThan(4000);
        expect(
          yield* Effect.result(
            session.selectOption(reference(limitedValue, named(limitedValue, "Many")), [
              unavailable.elementId,
            ]),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "select references survive selection away and require each node's revalidation after a hold",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const observed = yield* session.observe({ maxControls: 64 });
        const target = reference(observed, named(observed, "Single choice"));
        const option = named(observed, "Grouped");
        const stage = (yield* session.pages).find((page) => page.selected)!;
        const other = yield* session.createPage;

        yield* session.selectPage(other);
        expect(
          yield* Effect.result(session.selectOption(target, [option.elementId])),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        yield* session.selectPage(stage);
        const held = yield* PageControl.suspend(session, stage);

        yield* PageControl.resume(session, held);
        expect(
          yield* Effect.result(session.selectOption(target, [option.elementId])),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        yield* session.revalidateElement(target);
        expect(
          yield* Effect.result(session.selectOption(target, [option.elementId])),
        ).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        yield* session.revalidateElement(reference(observed, option));
        yield* session.selectOption(target, [option.elementId]);
        expect(yield* Effect.promise(() => page.locator("#events").textContent())).toBe(
          "input:single;change:single;",
        );
        expect((yield* session.status).phase).toBe("open");
      }),
    ).pipe(Effect.provide(layer)),
);
