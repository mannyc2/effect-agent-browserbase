import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import {
  BrowserPolicy,
  type FormField,
  type Observation,
  ObservedElement,
} from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import * as PageControl from "effect-browser/page-control";
import { chromium, type Page } from "playwright-core";

import { externalChromium, localSite } from "../fixtures/StandaloneBrowser.ts";

const form = `<!doctype html><title>Form steps</title>
<style>input,select,button{display:block;margin:6px}</style>
<form id=form action="https://example.test/PRIVATE-DESTINATION" method=post>
  <input id=email name=email type=email aria-label="Email">
  <input id=password name=password type=password aria-label="Password">
  <input id=phone name=phone type=tel aria-label="Phone">
  <input id=remember name=remember type=checkbox aria-label="Remember me">
  <input id=terms name=terms type=checkbox checked aria-label="Accept terms">
  <select id=country name=country aria-label="Country">
    <option value="PRIVATE-US">United States</option>
    <option value="PRIVATE-CA">Canada</option>
  </select>
  <input id=age name=age type=number aria-label="Age">
  <input id=born name=born type=date aria-label="Born">
  <input id=plan-a name=plan type=radio value=a checked aria-label="Plan A">
  <input id=plan-b name=plan type=radio value=b aria-label="Plan B">
  <button id=submit type=submit aria-label="Sign up">Sign up</button>
</form>
<output id=events></output>
<script>
// Content is loaded again into the same window, so nothing here is a global declaration.
{
  const log = (text) => { document.querySelector('#events').textContent += text + ';'; };
  document.querySelector('#form').addEventListener('submit', (event) => {
    event.preventDefault();
    log('submit:' + [...new FormData(event.target)].map(([k, v]) => k + '=' + v).join('&'));
  });
  document.addEventListener('click', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox')
      log('click:' + event.target.id);
  });
}
</script>`;

/** Page behaviour a test installs after loading the form and before observing it. */
type Behaviour = "rerender" | "reset" | "mask" | "enable" | "refuse";

const install = (page: Page, behaviour: Behaviour) =>
  Effect.promise(() =>
    page.evaluate((behaviour) => {
      const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

      switch (behaviour) {
        case "rerender":
          $("email").addEventListener("input", () =>
            $("password").replaceWith($("password").cloneNode()),
          );
          break;
        case "reset":
          $("password").addEventListener("input", () => setTimeout(() => ($("email").value = "")));
          break;
        case "mask":
          $("phone").addEventListener("input", () => {
            const digits = $("phone").value.replace(/\D/g, "");

            $("phone").value =
              digits.length === 10
                ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
                : digits;
          });
          break;
        case "enable":
          ($("submit") as unknown as HTMLButtonElement).disabled = true;
          document.addEventListener("input", () => {
            ($("submit") as unknown as HTMLButtonElement).disabled =
              $("email").value === "" || $("password").value === "";
          });
          break;
        case "refuse":
          $("remember").addEventListener("click", (event) => event.preventDefault());
          break;
      }
    }, behaviour),
  );

const fixture = Effect.fnUntraced(function* (behaviour?: Behaviour) {
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

  /** A fresh form with one page behaviour, on the same session. */
  const load = (next?: Behaviour) =>
    Effect.promise(() => page.setContent(form)).pipe(
      Effect.andThen(next === undefined ? Effect.void : install(page, next)),
    );

  yield* load(behaviour);

  return { session, page, load };
});

const events = (page: Page) =>
  Effect.promise(() =>
    page
      .locator("#events")
      .textContent()
      .then((text) => text ?? ""),
  );

const value = (page: Page, id: string) => Effect.promise(() => page.locator(`#${id}`).inputValue());

const id = (observation: Observation, label: string) => {
  const control = observation.controls.find((control) => control.label === label);

  assert.ok(control, label);

  return control.elementId;
};

const reference = (observation: Observation, label: string) =>
  ObservedElement.make({
    observationId: observation.observationId,
    elementId: id(observation, label),
  });

const text = (observation: Observation, label: string, value: string): FormField => ({
  elementId: id(observation, label),
  value,
});

const layer = Chromium.layer({ viewport: { width: 640, height: 900 } });
const controlled = Chromium.layer({ pageControl: true, viewport: { width: 640, height: 900 } });

it.live("a form sets text, toggles and options in order, then submits once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, page } = yield* fixture();
      const observed = yield* session.observe({ maxControls: 64 });

      const result = yield* session.fillForm({
        observationId: observed.observationId,
        fields: [
          text(observed, "Email", "ada@example.test"),
          text(observed, "Password", "PRIVATE-SECRET"),
          { elementId: id(observed, "Remember me"), checked: true },
          { elementId: id(observed, "Accept terms"), checked: true },
          { elementId: id(observed, "Country"), options: [id(observed, "Canada")] },
          { elementId: id(observed, "Plan B"), checked: true },
          text(observed, "Age", " 42 "),
          text(observed, "Born", "1990-01-15"),
        ],
        submit: id(observed, "Sign up"),
      });

      expect(result.submitted).toBe(true);
      expect(result.stopped).toBeUndefined();
      expect(result.fields.map((field) => field.status)).toEqual([
        "set",
        "set",
        "set",
        "unchanged",
        "set",
        "set",
        "set",
        "set",
      ]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE-");
      expect(yield* events(page)).toBe(
        "click:remember;submit:email=ada@example.test&password=PRIVATE-SECRET&phone=&remember=on&terms=on&country=PRIVATE-CA&age=42&born=1990-01-15&plan=b;",
      );
      // The form retired the observation it used.
      expect(
        yield* Effect.result(session.fillElement(reference(observed, "Email"), "again")),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Stale" }, outcome: "undispatched" },
      });
      expect((yield* session.status).phase).toBe("open");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a refused first step fails the form and a later one stops it before submit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, page } = yield* fixture("rerender");
      const observed = yield* session.observe({ maxControls: 64 });

      for (const field of [
        { elementId: id(observed, "Plan A"), checked: false },
        { elementId: id(observed, "Accept terms"), value: "x" },
        text(observed, "Age", "forty-two"),
        text(observed, "Born", "15 January 1990"),
      ])
        expect(
          yield* Effect.result(
            session.fillForm({ observationId: observed.observationId, fields: [field] }),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: {
            operation: "fill-form",
            reason: { _tag: "Unsupported" },
            outcome: "undispatched",
          },
        });
      expect(
        yield* Effect.result(
          session.fillForm(
            {
              observationId: observed.observationId,
              fields: [text(observed, "Email", "a@b.test")],
            },
            { admit: () => false },
          ),
        ),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Denied" }, outcome: "undispatched" },
      });
      expect(yield* value(page, "age")).toBe("");

      // Nothing was dispatched, so the observation is still the current one.
      const result = yield* session.fillForm({
        observationId: observed.observationId,
        fields: [
          text(observed, "Email", "ada@example.test"),
          text(observed, "Password", "PRIVATE-SECRET"),
          text(observed, "Phone", "5551234567"),
        ],
        submit: id(observed, "Sign up"),
      });

      expect(result).toMatchObject({
        fields: [{ status: "set" }],
        submitted: false,
        stopped: {
          stage: "field",
          elementId: id(observed, "Password"),
          error: { operation: "fill-form", reason: { _tag: "Stale" }, outcome: "undispatched" },
        },
      });
      expect(yield* value(page, "email")).toBe("ada@example.test");
      expect(yield* value(page, "phone")).toBe("");
      expect(yield* events(page)).toBe("");
      expect((yield* session.status).phase).toBe("open");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("verification stops a submit after an asynchronous reset and passes a mask", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reset = yield* fixture("reset");
      const observed = yield* reset.session.observe({ maxControls: 64 });

      const request = {
        observationId: observed.observationId,
        fields: [
          text(observed, "Email", "ada@example.test"),
          text(observed, "Password", "PRIVATE-SECRET"),
        ],
        submit: id(observed, "Sign up"),
      };

      expect(yield* reset.session.fillForm(request)).toMatchObject({
        fields: [{ status: "set" }, { status: "set" }],
        submitted: false,
        stopped: {
          stage: "verify",
          elementId: id(observed, "Email"),
          error: { reason: { _tag: "Stale" }, outcome: "undispatched" },
        },
      });
      expect(yield* events(reset.page)).toBe("");

      // A host that opts out of verification sends what its steps completed.
      const again = yield* reset.session.observe({ maxControls: 64 });

      expect(
        yield* reset.session.fillForm(
          {
            observationId: again.observationId,
            fields: [
              text(again, "Email", "ada@example.test"),
              text(again, "Password", "PRIVATE-SECRET"),
            ],
            submit: id(again, "Sign up"),
          },
          undefined,
          { verify: false },
        ),
      ).toMatchObject({ submitted: true });
      expect(yield* events(reset.page)).toContain("submit:email=&password=PRIVATE-SECRET");

      yield* reset.load("mask");
      const view = yield* reset.session.observe({ maxControls: 64 });

      expect(
        yield* reset.session.fillForm({
          observationId: view.observationId,
          fields: [text(view, "Phone", "5551234567"), text(view, "Email", "ada@example.test")],
          submit: id(view, "Sign up"),
        }),
      ).toMatchObject({ submitted: true });
      expect(yield* events(reset.page)).toContain("phone=(555) 123-4567");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a submit that became enabled is clicked, a refused toggle or submit stops the form", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const enabled = yield* fixture("enable");
      const observed = yield* enabled.session.observe({ maxControls: 64 });

      expect(observed.controls.find((control) => control.label === "Sign up")).toMatchObject({
        disabled: true,
      });
      expect(
        yield* enabled.session.fillForm({
          observationId: observed.observationId,
          fields: [
            text(observed, "Email", "ada@example.test"),
            text(observed, "Password", "PRIVATE-SECRET"),
          ],
          submit: id(observed, "Sign up"),
        }),
      ).toMatchObject({ submitted: true });
      expect(yield* events(enabled.page)).toContain("submit:email=ada@example.test");

      const refused = enabled;

      yield* refused.load("refuse");
      const view = yield* refused.session.observe({ maxControls: 64 });

      expect(
        yield* refused.session.fillForm({
          observationId: view.observationId,
          fields: [
            text(view, "Email", "ada@example.test"),
            { elementId: id(view, "Remember me"), checked: true },
          ],
          submit: id(view, "Sign up"),
        }),
      ).toMatchObject({
        fields: [{ status: "set" }, { status: "set" }],
        submitted: false,
        stopped: {
          stage: "field",
          elementId: id(view, "Remember me"),
          error: { reason: { _tag: "Failed" }, outcome: "rejected" },
        },
      });
      expect(yield* events(refused.page)).toBe("click:remember;");

      const denied = yield* refused.session.observe({ maxControls: 64 });

      expect(
        yield* refused.session.fillForm(
          {
            observationId: denied.observationId,
            fields: [text(denied, "Password", "PRIVATE-SECRET")],
            submit: id(denied, "Sign up"),
          },
          { admit: (facts) => facts.inputType !== "submit" },
        ),
      ).toMatchObject({
        fields: [{ status: "set" }],
        submitted: false,
        stopped: {
          stage: "submit",
          elementId: id(denied, "Sign up"),
          error: { reason: { _tag: "Denied" }, outcome: "undispatched" },
        },
      });
      expect(yield* events(refused.page)).toBe("click:remember;");
      expect((yield* refused.session.status).phase).toBe("open");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("fill refuses what native input would only refuse after dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, page } = yield* fixture();
      const observed = yield* session.observe({ maxControls: 64 });

      for (const [label, input, reason] of [
        ["Age", "forty-two", "Unsupported"],
        ["Born", "15/01/1990", "Unsupported"],
        ["Remember me", "on", "Unsupported"],
      ] as const)
        expect(
          yield* Effect.result(session.fillElement(reference(observed, label), input)),
        ).toMatchObject({
          _tag: "Failure",
          failure: { operation: "fill", reason: { _tag: reason }, outcome: "undispatched" },
        });
      yield* Effect.promise(() =>
        page.evaluate(() => {
          document.getElementById("phone")!.style.visibility = "hidden";
        }),
      );
      expect(
        yield* Effect.result(session.fillElement(reference(observed, "Phone"), "5551234567")),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "NotVisible" }, outcome: "undispatched" },
      });
      yield* session.fillElement(reference(observed, "Age"), "42");
      expect(yield* value(page, "age")).toBe("42");
      expect((yield* session.status).phase).toBe("open");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("match keeps matching controls and lines ahead of the control limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, page } = yield* fixture();

      yield* Effect.promise(() =>
        page.setContent(`<!doctype html><nav>${Array.from(
          { length: 24 },
          (_, i) => `<a href="/section-${i}">Section ${i}</a>`,
        ).join(" ")}</nav>
        <main><p>Welcome back</p><p>Sign in to continue</p>
        <form><input aria-label=Email><input aria-label=Password type=password>
        <button>Sign in</button></form>
        <select aria-label=Language><option>English</option><option>Deutsch</option></select>
        </main>`),
      );
      const crowded = yield* session.observe({ maxControls: 16 });

      expect(crowded.controls.some((control) => control.label === "Sign in")).toBe(false);

      const found = yield* session.observe({ match: "SIGN IN", maxControls: 16 });

      expect(found.match).toBe("SIGN IN");
      expect(found.controls.map((control) => control.label)).toEqual(["Sign in"]);
      expect(found.text.split("\n")).toEqual(["Sign in to continue", "Sign in"]);

      const language = yield* session.observe({ match: "deutsch", maxControls: 16 });

      expect(language.controls.map((control) => control.label)).toEqual([
        "Language",
        "English",
        "Deutsch",
      ]);
      yield* session.selectOption(reference(language, "Language"), [id(language, "Deutsch")]);

      const viewport = yield* session.observe({ scope: "viewport", match: "password" });

      expect(viewport.controls.map((control) => control.label)).toEqual(["Password"]);
      expect(yield* Effect.result(session.observe({ match: "   " }))).toMatchObject({
        _tag: "Failure",
        failure: { operation: "observe", reason: { _tag: "Configuration" } },
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a held page refuses a form until its nodes are revalidated, and a submit may navigate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, page } = yield* fixture();
        const observed = yield* session.observe({ maxControls: 64 });
        const stage = (yield* session.pages).find((candidate) => candidate.selected);

        assert.ok(stage);
        yield* PageControl.resume(session, yield* PageControl.suspend(session, stage));

        const request = {
          observationId: observed.observationId,
          fields: [text(observed, "Email", "ada@example.test")],
          submit: id(observed, "Sign up"),
        };

        expect(yield* Effect.result(session.fillForm(request))).toMatchObject({
          _tag: "Failure",
          failure: { operation: "fill-form", reason: { _tag: "Stale" }, outcome: "undispatched" },
        });
        // Revalidation is per node: the field may be set, but its submit control was not checked.
        yield* session.revalidateElement(reference(observed, "Email"));
        expect(yield* session.fillForm(request)).toMatchObject({
          fields: [{ status: "set" }],
          submitted: false,
          stopped: {
            stage: "submit",
            elementId: id(observed, "Sign up"),
            error: { reason: { _tag: "Stale" }, outcome: "undispatched" },
          },
        });
        expect(yield* events(page)).toBe("");

        const site = yield* localSite;

        yield* Effect.promise(() =>
          page.setContent(`<!doctype html><form action="${site.url}" method=get>
          <input name=q aria-label=Query><button>Search</button></form>`),
        );
        const search = yield* session.observe();

        expect(
          yield* session.fillForm({
            observationId: search.observationId,
            fields: [text(search, "Query", "effect")],
            submit: id(search, "Search"),
          }),
        ).toMatchObject({ fields: [{ status: "set" }], submitted: true });
        yield* Effect.promise(() => page.waitForURL(/[?]q=effect$/));
        expect((yield* session.observe()).url).toMatch(/[?]q=effect$/);
        expect((yield* session.status).phase).toBe("open");
      }),
    ).pipe(Effect.provide(controlled)),
);
