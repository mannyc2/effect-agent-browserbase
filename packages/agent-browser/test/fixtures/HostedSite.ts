import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";

import { receiptMarkup, signupMarkup } from "./ToolSite.ts";

/**
 * The served fixture's pages for a browser that cannot reach this host. An init script renders
 * them over any page of an allowed origin, a public one for a hosted browser, and the page
 * reports each write through a page-to-host binding: the host's ledger, not page state, is what
 * a grader reads, and no model-visible Tool can reach it.
 *
 * A lost acknowledgement cannot be shown this way. After an unknown outcome the owner fences its
 * callbacks along with everything else, so a page cannot report the write the case needs; that
 * case runs only against the served fixture.
 */

/**
 * A reserved example domain. The hosted browser fetches its page, which the fixture replaces;
 * no fixture data is sent to it.
 */
export const publicOrigin = "https://example.com";

export const HostedRoute = Schema.Literals(["signup", "signup-live", "receipt"]);
export type HostedRoute = typeof HostedRoute.Type;

/** Where a route is shown on an origin; a local origin serves a blank page to render over. */
export const hostedUrl = (origin: string, route: HostedRoute) =>
  origin === publicOrigin ? `${origin}/?view=${route}` : `${origin}/blank?view=${route}`;

const Write = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("submission"),
    email: Schema.String.check(Schema.isMaxLength(4096)),
    plan: Schema.String.check(Schema.isMaxLength(256)),
    terms: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("cancellation") }),
]);

/** The host's record of every write a page reported, in order. */
export interface HostedLedger {
  readonly submissions: Array<{ email: string; plan: string; terms: boolean }>;
  readonly cancellations: Array<string>;
}

export const emptyLedger = (): HostedLedger => ({ submissions: [], cancellations: [] });

const pages: Record<HostedRoute, { readonly title: string; readonly markup: string }> = {
  signup: { title: "Sign up", markup: signupMarkup },
  "signup-live": { title: "Sign up", markup: signupMarkup },
  receipt: { title: "Order receipt", markup: receiptMarkup },
};

const script = `(() => {
  const pages = ${JSON.stringify(pages)};
  const route = new URLSearchParams(location.search).get("view");
  const page = Object.prototype.hasOwnProperty.call(pages, route) ? pages[route] : undefined;
  // The page shows a write done only once the host has recorded it, as a server would.
  const record = (write, done) => { void globalThis.recordFixtureWrite(write).then(done, () => {}); };
  const render = () => {
    if (page === undefined) return true;
    document.head.innerHTML = '<meta charset="utf-8"><title></title>';
    document.title = page.title;
    document.body.innerHTML = page.markup;
    const signup = document.querySelector("#signup");
    if (signup !== null) {
      signup.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = new FormData(signup);
        record({
          kind: "submission",
          email: String(form.get("email") ?? ""),
          plan: String(form.get("plan") ?? ""),
          terms: form.has("terms"),
        }, () => {
          document.querySelector("#result").textContent =
            "Created " + form.get("email") + " on " + form.get("plan") + (form.has("terms") ? " with terms" : "");
        });
      });
      // A re-render replaces the submit button once an email is typed.
      if (route === "signup-live")
        document.querySelector("#email").addEventListener("input", () => {
          const create = document.querySelector("#create");
          create.replaceWith(create.cloneNode(true));
        }, { once: true });
    }
    const cancel = document.querySelector("#cancel");
    if (cancel !== null)
      cancel.addEventListener("click", () => {
        record({ kind: "cancellation" }, () => {
          document.querySelector("#status").textContent = "Order cancelled";
        });
      });
    return true;
  };
  globalThis.__evaluationFixture = document.readyState === "loading"
    ? new Promise((resolve) =>
        document.addEventListener("DOMContentLoaded", () => resolve(render()), { once: true }))
    : Promise.resolve(render());
})();`;

/** The bootstrap that renders the fixture on `origin` and records its writes into `ledger`. */
export const hostedFixture = (origin: string, ledger: HostedLedger) =>
  Bootstrap.combine(
    Bootstrap.binding({
      name: "recordFixtureWrite",
      origins: [origin],
      input: Write,
      output: Schema.Null,
      maxConcurrent: 16,
      maxInputBytes: 16 * 1024,
      maxOutputBytes: 16,
      timeoutMillis: 3000,
      failureMode: "reject-call",
      handle: (write) =>
        Effect.sync(() => {
          if (write.kind === "submission")
            ledger.submissions.push({ email: write.email, plan: write.plan, terms: write.terms });
          else ledger.cancellations.push("/order/cancel");

          return null;
        }),
    }),
    Bootstrap.init({
      id: "evaluation-fixture",
      origins: [origin],
      content: script,
      readiness: {
        expression: "globalThis.__evaluationFixture",
        timeoutMillis: 10_000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );
