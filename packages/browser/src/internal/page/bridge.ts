/**
 * The bridge to the page script. At the library's first read of a page, its own protocol session
 * registers the script, so every later document runs it in an isolated world from its start; calls
 * go to the current document's world. The script is composed from the domains' page-side parts,
 * the `*.inpage.ts` modules, in the order they depend on one another: names, the walk, matching,
 * context, subjects, text and readiness, then the outline and the input parts.
 */
import { Effect, Semaphore } from "effect";

import { BrowserError, Failed } from "../../BrowserError.ts";
import { edit, type Edit } from "../input/edit.inpage.ts";
import { evidence } from "../input/evidence.inpage.ts";
import { guard, type Guard } from "../input/guard.inpage.ts";
import { targets, type Targets } from "../input/targets.inpage.ts";
import { context } from "../reading/context.inpage.ts";
import { match } from "../reading/match.inpage.ts";
import { names } from "../reading/names.inpage.ts";
import { outline, type Outline } from "../reading/outline.inpage.ts";
import { ready } from "../reading/ready.inpage.ts";
import { subjects, type Subjects } from "../reading/subjects.inpage.ts";
import { text, type Texts } from "../reading/text.inpage.ts";
import { walk } from "../reading/walk.inpage.ts";
import { contextGone, type PageContext } from "./context.ts";

/** What the script installs: a version, and a function of one of its parts for each call. */
export interface PageApi {
  readonly version: number;
  snapshot: Outline["snapshot"];
  find: Subjects["find"];
  text: Texts["read"];
  ready: ReturnType<typeof ready>["wait"];
  point: Targets["point"];
  scrollPlan: Targets["scrollPlan"];
  viewport: Outline["viewport"];
  prepareInput: Guard["prepareInput"];
  validateInput: Guard["validateInput"];
  typeable: Edit["typeable"];
  focus: Edit["focus"];
  checkText: Edit["checkText"];
  select: Edit["select"];
}

declare global {
  // The API this script installs, which exists only inside the library's isolated world.
  var __effectBrowser: PageApi | undefined;
}

// Like the parts it receives, this is evaluated from its source text.
const install = (
  makeNames: typeof names,
  makeWalk: typeof walk,
  makeMatch: typeof match,
  makeContext: typeof context,
  makeSubjects: typeof subjects,
  makeText: typeof text,
  makeReady: typeof ready,
  makeOutline: typeof outline,
  makeTargets: typeof targets,
  makeEvidence: typeof evidence,
  makeGuard: typeof guard,
  makeEdit: typeof edit,
): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 9) return installed;
  const named = makeNames();
  const walked = makeWalk(named);
  const placing = makeContext(named, walked);
  const subjected = makeSubjects(named, walked, makeMatch(), placing);
  const texts = makeText(named, walked);
  const read = makeOutline(named, walked, subjected, texts);
  const located = makeTargets(named, walked, placing);
  const guarded = makeGuard(named, located, makeEvidence(named, placing));
  const edited = makeEdit(named, guarded, placing);

  const api: PageApi = {
    version: 9,
    snapshot: read.snapshot,
    find: subjected.find,
    text: texts.read,
    ready: makeReady(walked, texts).wait,
    point: located.point,
    scrollPlan: located.scrollPlan,
    viewport: read.viewport,
    prepareInput: guarded.prepareInput,
    validateInput: guarded.validateInput,
    typeable: edited.typeable,
    focus: edited.focus,
    checkText: edited.checkText,
    select: edited.select,
  };

  globalThis.__effectBrowser = api;

  return api;
};

/** The expression that installs the script and evaluates to its API. */
export const installSource = `(${install.toString()})(${[names, walk, match, context, subjects, text, ready, outline, targets, evidence, guard, edit].join(", ")})`;

const worldName = "effect-browser";

// What a call reads in a world without the script's API. A context id can name another world once
// the page has moved to a new process, so a cached id that reads this is not the library's world.
const missing = "effect-browser: no __effectBrowser in this world";

const isMissing = (error: BrowserError) =>
  error.reason._tag === "Failed" && error.reason.detail === missing;

/** A call to the page script, its arguments quoted as JavaScript literals. */
export const scriptCall = (name: string, ...args: ReadonlyArray<unknown>): string =>
  `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

export const make = Effect.fnUntraced(function* (page: PageContext) {
  const { cdp, native, span } = page;
  const { send } = page.protocol;
  const registering = yield* Semaphore.make(1);
  // The main frame's id, which is the page's target id, and whether this session has registered
  // the script and has the Page domain on.
  let frameId: string | undefined;
  let registered = false;
  let paging = false;
  // The current document's world, forgotten when the main frame commits another document, and the
  // commits this session has seen, the latest marked on the page. Only a commit is a new document:
  // `frameStartedLoading` also fires on `pushState`.
  let world: number | undefined;
  let documents = 0;

  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId !== undefined) return;
    documents++;
    page.activity.documentAt = page.now();
    world = undefined;
  });

  // The Page domain's events, commits among them, reach a session only once it enables the domain.
  const enablePage = (operation: string) =>
    Effect.suspend(() =>
      paging
        ? Effect.void
        : native(operation, () => send("Page.enable")).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                paging = true;
              }),
            ),
          ),
    );

  /**
   * The main-frame commits seen so far, with the Page domain on so that every later one counts. A
   * commit within about one round trip of the count can still be missed.
   */
  const currentDocument = (operation: string) =>
    enablePage(operation).pipe(Effect.map(() => documents));

  const mainFrame = (operation: string) =>
    Effect.suspend(() =>
      frameId === undefined
        ? native(operation, () => send("Target.getTargetInfo")).pipe(
            Effect.map(({ targetInfo }) => {
              frameId = targetInfo.targetId;

              return targetInfo.targetId;
            }),
          )
        : Effect.succeed(frameId),
    );

  // The registration belongs to this session and the world to the page, so a session that attaches
  // later, as after a reconnect, registers again and finds the script already installed. With the
  // Page domain enabled, the script runs in each new document; `runImmediately` installs it now.
  const register = (operation: string) =>
    Effect.all(
      [
        mainFrame(operation),
        enablePage(operation),
        native(operation, () =>
          send("Page.addScriptToEvaluateOnNewDocument", {
            source: `if (globalThis === globalThis.top) ${installSource};`,
            worldName,
            runImmediately: true,
          }),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          registered = true;
        }),
      ),
      span("Page.register", {}, "Debug"),
    );

  const registeredFrame = (operation: string) =>
    registering
      .withPermits(1)(Effect.suspend(() => (registered ? Effect.void : register(operation))))
      .pipe(Effect.andThen(mainFrame(operation)));

  const createWorld = (operation: string) =>
    Effect.gen(function* () {
      const frame = yield* registeredFrame(operation);
      const document = documents;

      const created = yield* native(operation, () =>
        send("Page.createIsolatedWorld", { frameId: frame, worldName }),
      );

      // A world the page replaced while it was being looked up serves this call, not later ones.
      if (document === documents) world = created.executionContextId;

      return created.executionContextId;
    }).pipe(span("Page.createWorld", {}, "Debug"));

  /** The current document's world, created if it has none yet. */
  const current = (operation: string) =>
    Effect.suspend(() => (world === undefined ? createWorld(operation) : Effect.succeed(world)));

  /** A world of the current document without the page script, as the clock probe needs. */
  const bareWorld = (operation: string) =>
    mainFrame(operation).pipe(
      Effect.flatMap((frame) =>
        native(operation, () =>
          send("Page.createIsolatedWorld", { frameId: frame, worldName: `${worldName}-clock` }),
        ),
      ),
      Effect.map((created) => created.executionContextId),
    );

  const run = (operation: string, expression: string, contextId: number) =>
    native(operation, () =>
      send("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true }),
    ).pipe(
      Effect.flatMap((result) =>
        result.exceptionDetails === undefined
          ? Effect.succeed<unknown>(result.result.value)
          : Effect.fail(
              new BrowserError({
                operation,
                reason: new Failed({
                  detail:
                    result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
                }),
                dispatched: false,
              }),
            ),
      ),
    );

  const evaluateIn = (operation: string, call: string, contextId: number) =>
    run(
      operation,
      `globalThis.__effectBrowser === undefined ? ${JSON.stringify(missing)} : globalThis.__effectBrowser.${call}`,
      contextId,
    ).pipe(
      Effect.filterOrFail(
        (value) => value !== missing,
        () =>
          new BrowserError({
            operation,
            reason: new Failed({ detail: missing }),
            dispatched: false,
          }),
      ),
      // One round trip to the page. Its arguments can hold typed text, so only the call is named.
      span("Page.evaluate", { function: call.split("(")[0] }, "Trace"),
    );

  // Ordinary reads can recreate a document's world. Approval validation deliberately cannot. A
  // world found by its name that lacks the script, in a document the registration missed, gets it.
  const evaluateWithContext = (operation: string, call: string) => {
    const attempt = (contextId: number) =>
      evaluateIn(operation, call, contextId).pipe(Effect.map((value) => ({ contextId, value })));

    const again = createWorld(operation).pipe(
      Effect.flatMap((contextId) =>
        attempt(contextId).pipe(
          Effect.catchIf(isMissing, () =>
            run(operation, `${installSource}.version`, contextId).pipe(
              Effect.andThen(attempt(contextId)),
            ),
          ),
        ),
      ),
    );

    return current(operation).pipe(
      Effect.flatMap(attempt),
      Effect.catchIf(contextGone, () => again),
    );
  };

  const evaluate = (operation: string, call: string) =>
    evaluateWithContext(operation, call).pipe(Effect.map(({ value }) => value));

  return { current, bareWorld, evaluate, evaluateIn, evaluateWithContext, currentDocument };
});

export type Bridge = Effect.Success<ReturnType<typeof make>>;
