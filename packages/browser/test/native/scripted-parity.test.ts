import { createServer } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schedule, type Scope } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy, ObservedElement, type Observation } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import * as Testing from "effect-browser/testing";

/**
 * One case list, two owners. The scripted engine and a real Chromium over CDP must classify
 * the same situations with the same reason and outcome; this suite is the evidence that the
 * scripted vocabulary is the real one, not a re-statement of it.
 */
const page = (consented: boolean) =>
  consented
    ? `<!doctype html><title>Parity</title><main>Welcome back.</main>`
    : `<!doctype html><title>Parity</title>
<main>We use cookies.</main>
<button id="accept" onclick="location.assign('/?consent=1')">Accept all</button>
<a id="terms" href="https://evil.test/terms">Terms</a>
<input id="name" aria-label="Name" type="text">
<input id="news" aria-label="Newsletter" type="checkbox">
<input id="code" aria-label="Code" type="text" disabled>
<a id="report" href="https://evil.test/" style="position:absolute;top:5000px;left:0">Report</a>`;

const site = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly close: () => Promise<void> }>(
        (resolve, reject) => {
          const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");

            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(page(url.searchParams.get("consent") === "1"));
          });

          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (address === null || typeof address === "string") {
              reject(new Error("No parity site address"));

              return;
            }
            resolve({
              origin: `http://127.0.0.1:${address.port}`,
              close: () =>
                new Promise<void>((done) => {
                  server.closeAllConnections();
                  server.close(() => done());
                }),
            });
          });
        },
      ),
  ),
  (running) => Effect.promise(running.close),
);

const script = (origin: string): Testing.Script => ({
  documents: [
    {
      url: `${origin}/`,
      text: "We use cookies.",
      controls: [
        // A script-driven button: no destination fact, as a real `onclick` handler has none.
        { id: "accept", kind: "button", label: "Accept all", activates: `${origin}/?consent=1` },
        { id: "terms", kind: "link", label: "Terms", destination: "https://evil.test/terms" },
        { id: "name", kind: "input", label: "Name", inputType: "text" },
        { id: "news", kind: "input", label: "Newsletter", inputType: "checkbox" },
        { id: "code", kind: "input", label: "Code", inputType: "text", disabled: true },
        {
          id: "report",
          kind: "link",
          label: "Report",
          destination: "https://evil.test/",
          offscreen: true,
        },
      ],
    },
    { url: `${origin}/?consent=1`, text: "Welcome back." },
  ],
});

type Open = (
  origin: string,
  policy: BrowserPolicy,
  actionTimeoutMillis?: number,
) => Effect.Effect<Browser.AnySession, BrowserError | InitializationError, Scope.Scope>;

const openScripted: Open = (origin, policy, actionTimeoutMillis) =>
  Testing.open<BrowserError | InitializationError, never>(script(origin), {
    policy,
    ...(actionTimeoutMillis === undefined ? {} : { automation: { actionTimeoutMillis } }),
  });

const openChromium: Open = (origin, policy, actionTimeoutMillis) =>
  Effect.gen(function* () {
    // The real owner is launched per case, so budgets and receipts start fresh each time.
    void origin;

    return yield* Chromium.launch(policy);
  }).pipe(
    Effect.provide(
      Chromium.layer({
        launch: {
          ...(process.env.BROWSERBASE_CHROMIUM === undefined
            ? {}
            : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
          chromiumSandbox: false,
          startupTimeoutMillis: 25000,
        },
        viewport: { width: 640, height: 480 },
        ...(actionTimeoutMillis === undefined ? {} : { actionTimeoutMillis }),
      }),
    ),
  );

const named = (observation: Observation, label: string) => {
  const control = observation.controls.find((candidate) => candidate.label === label);

  expect(control, `observed control ${label}`).toBeDefined();

  return ObservedElement.make({
    observationId: observation.observationId,
    elementId: control?.elementId ?? "",
  });
};

/** The refusal an operation ends in, or an explicit assertion failure when it succeeded. */
const failure = <A>(effect: Effect.Effect<A, BrowserError>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) =>
      result._tag === "Failure"
        ? { reason: result.failure.reason._tag, outcome: result.failure.outcome }
        : { reason: "succeeded", outcome: JSON.stringify(result.success) },
    ),
  );

interface Case {
  readonly name: string;
  readonly policy?: BrowserPolicy;
  readonly actionTimeoutMillis?: number;
  readonly run: (session: Browser.AnySession, origin: string) => Effect.Effect<void, BrowserError>;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "a dispatched click retires the observation it was named from",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();
        const clicked = yield* session.clickElement(named(observation, "Accept all"));

        expect(clicked.url).toBe(`${origin}/?consent=1`);
        expect(yield* failure(session.clickElement(named(observation, "Accept all")))).toEqual({
          reason: "Stale",
          outcome: "undispatched",
        });
        expect((yield* session.observe()).text).toContain("Welcome back.");
      }),
  },
  {
    name: "admission refuses before anything is dispatched",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        expect(
          yield* failure(
            session.clickElement(named(observation, "Terms"), {
              admit: (facts) => facts.destination === undefined,
            }),
          ),
        ).toEqual({ reason: "Denied", outcome: "undispatched" });
        // Nothing was sent, so the observation is still current and the button still admissible.
        yield* session.clickElement(named(observation, "Accept all"), {
          admit: (facts) => facts.destination === undefined,
        });
      }),
  },
  {
    name: "the action budget refuses undispatched with measured facts",
    policy: BrowserPolicy.unrestricted({ maxActions: 2 }),
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        yield* session.observe();
        const refused = yield* session.observe().pipe(Effect.result);

        expect(refused._tag === "Failure" ? refused.failure : refused).toMatchObject({
          reason: { _tag: "Limit", dimension: "actions", maximum: 2, observed: 2 },
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "a selector that matches nothing is not found",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        expect(yield* failure(session.click({ selector: "#missing" }))).toEqual({
          reason: "NotFound",
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "real key input needs focus and is never sent without it",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        expect(yield* failure(session.typeElement(named(observation, "Name"), "Ada"))).toEqual({
          reason: "NotFocused",
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "a disabled input is refused before any text is sent",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        expect(yield* failure(session.fillElement(named(observation, "Code"), "42"))).toEqual({
          reason: "Disabled",
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "a form sets fields in order and stops, undispatched, at a disabled one",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        const result = yield* session.fillForm({
          observationId: observation.observationId,
          fields: [
            { elementId: named(observation, "Name").elementId, value: "Ada" },
            { elementId: named(observation, "Newsletter").elementId, checked: true },
            { elementId: named(observation, "Code").elementId, value: "42" },
          ],
          submit: named(observation, "Accept all").elementId,
        });

        expect({
          fields: result.fields.map((field) => field.status),
          submitted: result.submitted,
          stage: result.stopped?.stage,
          reason: result.stopped?.error.reason._tag,
          outcome: result.stopped?.error.outcome,
        }).toEqual({
          fields: ["set", "set"],
          submitted: false,
          stage: "field",
          reason: "Disabled",
          outcome: "undispatched",
        });
        // What the form dispatched retired its observation.
        expect(yield* failure(session.fillElement(named(observation, "Name"), "Grace"))).toEqual({
          reason: "Stale",
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "a verified form submits once and reports where it led",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        const result = yield* session.fillForm({
          observationId: observation.observationId,
          fields: [
            { elementId: named(observation, "Name").elementId, value: "Ada" },
            { elementId: named(observation, "Newsletter").elementId, checked: true },
          ],
          submit: named(observation, "Accept all").elementId,
        });

        expect({
          fields: result.fields.map((field) => field.status),
          submitted: result.submitted,
          url: result.url,
          stopped: result.stopped,
        }).toEqual({
          fields: ["set", "set"],
          submitted: true,
          url: `${origin}/?consent=1`,
          stopped: undefined,
        });
      }),
  },
  {
    name: "a matched reading keeps only the controls that match",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const matched = yield* session.observe({ match: "NEWS" });

        expect({
          match: matched.match,
          controls: matched.controls.map((control) => [control.label, control.checked]),
        }).toEqual({ match: "NEWS", controls: [["Newsletter", false]] });
      }),
  },
  {
    name: "moving the selection leaves a pending wait running to its own deadline",
    actionTimeoutMillis: 1500,
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const home = (yield* session.pages).find((page) => page.selected);

        expect(home).toBeDefined();
        if (home === undefined) return;

        const pending = yield* failure(
          session.waitFor({ selector: "#never", state: "attached" }),
        ).pipe(Effect.forkChild);

        // The wait's short admission guard retires once the native wait has started.
        yield* session
          .selectPage(home)
          .pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("5 millis") }));
        expect(yield* Fiber.join(pending)).toEqual({ reason: "Timeout", outcome: "undispatched" });
      }),
  },
  {
    name: "an off-screen control cannot be hovered",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        const observation = yield* session.observe();

        expect(yield* failure(session.hoverElement(named(observation, "Report")))).toEqual({
          reason: "NotVisible",
          outcome: "undispatched",
        });
      }),
  },
  {
    name: "a closed session refuses undispatched",
    run: (session, origin) =>
      Effect.gen(function* () {
        yield* session.navigate({ url: `${origin}/` });
        yield* session.closeChecked;
        expect(yield* failure(session.observe())).toEqual({
          reason: "Closed",
          outcome: "undispatched",
        });
        expect((yield* session.status).phase).toBe("closed");
      }),
  },
];

for (const [owner, open] of [
  ["scripted", openScripted],
  ["chromium", openChromium],
] as const) {
  for (const parity of cases) {
    it.live(`${parity.name} (${owner})`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* site;
          const policy = parity.policy ?? BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 });

          yield* Browser.scoped(
            open(running.origin, policy, parity.actionTimeoutMillis),
            (session) => parity.run(session, running.origin),
          );
        }),
      ),
    );
  }
}
