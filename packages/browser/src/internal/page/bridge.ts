/**
 * The bridge to the page script. Each document gets an isolated world with the script installed
 * in it, and calls go to that world. The script is composed from the domains' page-side parts,
 * the `*.inpage.ts` modules, in the order they depend on one another: names, the walk, matching,
 * context, subjects and text, then the outline and the input parts.
 */
import { Effect, Option, Ref } from "effect";

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

/** A call to the page script, its arguments quoted as JavaScript literals. */
export const scriptCall = (name: string, ...args: ReadonlyArray<unknown>): string =>
  `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

export const make = Effect.fnUntraced(function* (page: PageContext) {
  const { cdp, native, span } = page;
  const world = yield* Ref.make(Option.none<number>());
  // The main frame keeps its id from one document to the next, so it is looked up once.
  const mainFrame = yield* Ref.make(Option.none<string>());

  const createWorld = (operation: string) =>
    Effect.gen(function* () {
      const lookup = native(operation, () => cdp.send("Page.getFrameTree")).pipe(
        Effect.map((tree) => tree.frameTree.frame.id),
        Effect.tap((id) => Ref.set(mainFrame, Option.some(id))),
      );

      const isolate = (frameId: string) =>
        native(operation, () =>
          cdp.send("Page.createIsolatedWorld", { frameId, worldName: "effect-browser" }),
        );

      // A remembered id that no longer names the main frame is looked up again.
      const created = yield* Option.match(yield* Ref.get(mainFrame), {
        onNone: () => Effect.flatMap(lookup, isolate),
        onSome: (frameId) =>
          isolate(frameId).pipe(Effect.catch(() => Effect.flatMap(lookup, isolate))),
      });

      const installed = yield* native(operation, () =>
        cdp.send("Runtime.evaluate", {
          contextId: created.executionContextId,
          expression: `${installSource}.version`,
          returnByValue: true,
        }),
      );

      if (installed.exceptionDetails !== undefined)
        return yield* new BrowserError({
          operation,
          reason: new Failed({ detail: installed.exceptionDetails.text }),
          dispatched: false,
        });
      yield* Ref.set(world, Option.some(created.executionContextId));

      return created.executionContextId;
    }).pipe(span("Page.createWorld", {}, "Debug"));

  /** The current document's world, created if it has none yet. */
  const current = (operation: string) =>
    Ref.get(world).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => createWorld(operation), onSome: Effect.succeed }),
      ),
    );

  const evaluateIn = (operation: string, call: string, contextId: number) =>
    native(operation, () =>
      cdp.send("Runtime.evaluate", {
        contextId,
        expression: `globalThis.__effectBrowser.${call}`,
        returnByValue: true,
        awaitPromise: true,
      }),
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
      // One round trip to the page. Its arguments can hold typed text, so only the call is named.
      span("Page.evaluate", { function: call.split("(")[0] }, "Trace"),
    );

  // Ordinary reads can recreate a document's world. Approval validation deliberately cannot.
  const evaluateWithContext = (operation: string, call: string) => {
    const attempt = (contextId: number) =>
      evaluateIn(operation, call, contextId).pipe(Effect.map((value) => ({ contextId, value })));

    return current(operation).pipe(
      Effect.flatMap(attempt),
      Effect.catchIf(contextGone, () => createWorld(operation).pipe(Effect.flatMap(attempt))),
    );
  };

  const evaluate = (operation: string, call: string) =>
    evaluateWithContext(operation, call).pipe(Effect.map(({ value }) => value));

  return { current, evaluate, evaluateIn, evaluateWithContext };
});

export type Bridge = Effect.Success<ReturnType<typeof make>>;
