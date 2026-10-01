import { Effect } from "effect";
import type { BrowserSession, Page } from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { type BrowserError } from "effect-browser/errors";
import { StepFailed, type RunOptions } from "effect-browser/plan";
import * as Testing from "effect-browser/testing";

export const fixtureScript: Testing.Script = {
  documents: [
    {
      url: "https://example.test/",
      text: "Example",
      controls: [
        { id: "element-1", kind: "input", label: "Name", inputType: "text" },
        { id: "element-2", kind: "input", label: "Consent", inputType: "checkbox", checked: true },
        { id: "element-3", kind: "select", label: "Country", multiple: false },
        { id: "element-4", kind: "other", label: "France", selectElementId: "element-3" },
        { id: "element-5", kind: "button", label: "Send", inputType: "submit" },
        { id: "option-1", kind: "other", label: "Belgium", selectElementId: "element-3" },
        { id: "control", kind: "button", label: "Control" },
      ],
    },
  ],
};

/** The ordinary browser runtime issues every Session, Page, reference and RunOperation here. */
export const scriptedSession = Effect.fnUntraced(function* (
  options: {
    readonly beforeStart?: (
      action: Parameters<Page["start"]>[0]["steps"][number]["action"],
      options: RunOptions | undefined,
    ) => Effect.Effect<unknown, BrowserError>;
    readonly beforeNavigation?: () => Effect.Effect<unknown, BrowserError>;
    readonly observe?: Page["observe"];
    readonly readText?: Page["readText"];
    readonly status?: BrowserSession["status"];
    readonly failure?: BrowserSession["failure"];
    readonly script?: Testing.Script;
  } = {},
) {
  const session = yield* Testing.open(options.script ?? fixtureScript, {
    policy: BrowserPolicy.unrestricted({ maxActions: 1000, maxElapsedMillis: 600000 }),
  });

  const page = session.initialPage;

  // Seed real exact-node references before installing a bounded result-projection seam.
  yield* page.observe();
  const beforeStart = options.beforeStart;

  if (beforeStart !== undefined) {
    const original = page.start;

    const start: Page["start"] = (plan, configuration) =>
      Effect.suspend(() => {
        const action = plan.steps[0]?.action;

        return action === undefined
          ? original(plan, configuration)
          : beforeStart(action, configuration).pipe(
              Effect.mapError(
                (error) => new StepFailed({ stage: "PreparationFailed", completed: [], error }),
              ),
              Effect.andThen(original(plan, configuration)),
            );
      });

    Object.assign(page, { start });
  }
  const beforeNavigation = options.beforeNavigation;

  if (beforeNavigation !== undefined) {
    const original = page.startNavigation;

    Object.assign(page, {
      startNavigation: ((request, configuration) =>
        beforeNavigation().pipe(
          Effect.andThen(original(request, configuration)),
        )) satisfies Page["startNavigation"],
    });
  }
  if (options.observe !== undefined) Object.assign(page, { observe: options.observe });
  if (options.readText !== undefined) Object.assign(page, { readText: options.readText });
  if (options.status !== undefined) Object.assign(session, { status: options.status });
  if (options.failure !== undefined) Object.assign(session, { failure: options.failure });

  return session;
});
