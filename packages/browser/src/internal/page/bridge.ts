/**
 * The bridge to the page script. At the library's first read of a page, its own protocol session
 * registers the script, so every later document runs it in an isolated world from its start; calls
 * go to the current document's world. The script is composed from the domains' page-side parts,
 * the `*.inpage.ts` modules, in the order they depend on one another: names, the walk, matching,
 * context, subjects and text, then the outline and the input parts.
 */
import { Effect, Semaphore } from "effect";

import { BrowserError, Failed } from "../../BrowserError.ts";
import {
  edit,
  type EditResult,
  type FocusResult,
  type TypeableResult,
} from "../input/edit.inpage.ts";
import { evidence } from "../input/evidence.inpage.ts";
import {
  guard,
  type InputPlan,
  type PreparedInput,
  type PreparedInputResult,
  type ValidatedInputResult,
  type ValidationOptions,
} from "../input/guard.inpage.ts";
import { type PointResult, targets } from "../input/targets.inpage.ts";
import { context } from "../reading/context.inpage.ts";
import { type FindRequest, match } from "../reading/match.inpage.ts";
import { names } from "../reading/names.inpage.ts";
import { outline, type SnapshotRequest, type SnapshotResult } from "../reading/outline.inpage.ts";
import { type FindResult, subjects } from "../reading/subjects.inpage.ts";
import { text, type TextRequest, type TextResult } from "../reading/text.inpage.ts";
import { walk } from "../reading/walk.inpage.ts";
import { contextGone, type PageContext } from "./context.ts";

export interface PageApi {
  readonly version: number;
  snapshot(request: SnapshotRequest): SnapshotResult;
  find(request: FindRequest): FindResult;
  text(request: TextRequest): TextResult;
  point(target: string | { readonly x: number; readonly y: number }, scroll?: boolean): PointResult;
  scrollPlan(
    ref: string,
  ): { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number } | null;
  viewport(): { readonly width: number; readonly height: number };
  prepareInput(plan: InputPlan): PreparedInputResult;
  validateInput(
    plan: InputPlan,
    prepared: PreparedInput,
    options?: ValidationOptions,
  ): ValidatedInputResult | Promise<ValidatedInputResult>;
  typeable(ref: string | null): TypeableResult;
  focus(ref: string, replace: boolean): FocusResult;
  checkText(ref: string, expected: string): EditResult;
  select(ref: string, values: ReadonlyArray<string>): EditResult;
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
  makeOutline: typeof outline,
  makeTargets: typeof targets,
  makeEvidence: typeof evidence,
  makeGuard: typeof guard,
  makeEdit: typeof edit,
): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 6) return installed;
  const named = makeNames();
  const walked = makeWalk(named);
  const placing = makeContext(named);
  const subjected = makeSubjects(named, walked, makeMatch(), placing);
  const texts = makeText(named, walked);
  const read = makeOutline(named, walked, subjected, texts);
  const located = makeTargets(named, walked, placing);
  const guarded = makeGuard(named, located, makeEvidence(named, placing));
  const edited = makeEdit(named, guarded);

  const api: PageApi = {
    version: 6,
    snapshot: read.snapshot,
    find: subjected.find,
    text: texts.read,
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
export const installSource = `(${install.toString()})(${[names, walk, match, context, subjects, text, outline, targets, evidence, guard, edit].join(", ")})`;

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
  const { cdp, send, native, span } = page;
  const registering = yield* Semaphore.make(1);
  // The main frame's id, which is the page's target id, and whether this session has registered
  // the script.
  let frameId: string | undefined;
  let registered = false;
  // The current document's world, forgotten when the main frame commits another document. Only a
  // commit is a new document: `frameStartedLoading` also fires on `pushState`.
  let world: number | undefined;
  let documents = 0;

  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId !== undefined) return;
    documents++;
    world = undefined;
  });

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
        native(operation, () => send("Page.enable")),
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
    Effect.suspend(() =>
      registered
        ? mainFrame(operation)
        : registering
            .withPermits(1)(Effect.suspend(() => (registered ? Effect.void : register(operation))))
            .pipe(Effect.andThen(mainFrame(operation))),
    );

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
      Effect.catchIf(contextGone, () =>
        Effect.suspend(() => {
          world = undefined;

          return again;
        }),
      ),
    );
  };

  const evaluate = (operation: string, call: string) =>
    evaluateWithContext(operation, call).pipe(Effect.map(({ value }) => value));

  return { current, bareWorld, evaluate, evaluateIn, evaluateWithContext };
});

export type Bridge = Effect.Success<ReturnType<typeof make>>;
