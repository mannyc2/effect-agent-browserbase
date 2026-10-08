/**
 * The bridge to the page script, and the page's documents as its own session sees them commit. At
 * the library's first read of a page, its own protocol session registers the script, so every
 * later document runs it in an isolated world from its start; calls go to the current document's
 * world. The script is composed from the domains' page-side parts, the `*.inpage.ts` modules, in
 * the order they depend on one another. At the first read of a page's changes, its session
 * registers the recorder too, so every later document records from its start.
 */
import { Effect, Schema, SynchronizedRef } from "effect";

import { type BrowserError, Failed } from "../../BrowserError.ts";
import { Navigated } from "../../BrowserEvent.ts";
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
import { changes, type Changes } from "../timeline/changes.inpage.ts";
import { fold } from "../timeline/fold.inpage.ts";
import { history } from "../timeline/history.inpage.ts";
import { marks } from "../timeline/marks.inpage.ts";
import { record, type Recorder } from "../timeline/record.inpage.ts";
import { sight } from "../timeline/sight.inpage.ts";
import { contextGone, failWith, type PageContext, undispatched } from "./context.ts";
import * as Url from "./url.ts";

/** What the script installs: a version, and a function of one of its parts for each call. */
export interface PageApi {
  readonly version: number;
  snapshot: Outline["snapshot"];
  find: Subjects["find"];
  text: Texts["read"];
  record: Recorder["start"];
  changes: Changes["read"];
  ready: ReturnType<typeof ready>["wait"];
  settle: ReturnType<typeof ready>["settle"];
  point: Targets["point"];
  scrollPlan: Targets["scrollPlan"];
  viewport: Outline["viewport"];
  prepareInput: Guard["prepareInput"];
  validateInput: Guard["validateInput"];
  typeable: Edit["typeable"];
  focus: Edit["focus"];
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
  makeFold: typeof fold,
  makeHistory: typeof history,
  makeSight: typeof sight,
  makeMarks: typeof marks,
  makeRecord: typeof record,
  makeChanges: typeof changes,
  makeReady: typeof ready,
  makeOutline: typeof outline,
  makeTargets: typeof targets,
  makeEvidence: typeof evidence,
  makeGuard: typeof guard,
  makeEdit: typeof edit,
  makeAddresses: typeof Url.addresses,
): PageApi => {
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === 13) return installed;
  const named = makeNames();
  const walked = makeWalk(named);
  const placing = makeContext(named, walked);
  const subjected = makeSubjects(named, walked, makeMatch(), placing);
  const texts = makeText(named, walked);
  const kept = makeHistory(makeFold());
  const seeing = makeSight(named, walked, texts, kept);
  const marking = makeMarks(named, kept, seeing);
  const recorder = makeRecord(named, texts, kept, seeing, marking);
  const read = makeOutline(named, walked, subjected, texts, makeAddresses());
  const located = makeTargets(named, walked, placing);
  const guarded = makeGuard(named, located, makeEvidence(named, placing));
  const edited = makeEdit(named, guarded, placing);
  const readiness = makeReady(walked, texts, kept);

  const api: PageApi = {
    version: 13,
    snapshot: read.snapshot,
    find: subjected.find,
    text: texts.read,
    record: recorder.start,
    changes: makeChanges(named, placing, kept, seeing, marking, recorder).read,
    ready: readiness.wait,
    settle: readiness.settle,
    point: located.point,
    scrollPlan: located.scrollPlan,
    viewport: read.viewport,
    prepareInput: guarded.prepareInput,
    validateInput: guarded.validateInput,
    typeable: edited.typeable,
    focus: edited.focus,
    select: edited.select,
  };

  globalThis.__effectBrowser = api;

  return api;
};

/** The expression that installs the script and evaluates to its API. */
export const installSource = `(${install.toString()})(${[names, walk, match, context, subjects, text, fold, history, sight, marks, record, changes, ready, outline, targets, evidence, guard, edit, Url.addresses].join(", ")})`;

const worldName = "effect-browser";

// What starts the recorder in each new document, after the script installed itself there.
const recorderSource = `if (globalThis === globalThis.top) globalThis.__effectBrowser?.record();`;

// What a call reads in a world without the script's API. A context id can name another world once
// the page has moved to a new process, so a cached id that reads this is not the library's world.
const missing = "effect-browser: no __effectBrowser in this world";

const isMissing = (error: BrowserError) =>
  error.reason._tag === "Failed" && error.reason.detail === missing;

/** A frame as a page session reports its commit. */
export const Commit = Schema.Struct({
  parentId: Schema.optionalKey(Schema.String),
  loaderId: Schema.String,
  url: Schema.String,
  urlFragment: Schema.optionalKey(Schema.String),
});

/** `Page.frameNavigated` or `Page.navigatedWithinDocument`, as far as `mainFrame` reads them. */
export const MainFrameEvent = Schema.Union([
  Schema.Struct({ frame: Commit }),
  Schema.Struct({ frameId: Schema.String, url: Schema.String }),
]);

/** A commit's loader and its address, redacted. */
export const commitOf = ({ loaderId, url, urlFragment = "" }: typeof Commit.Type) => ({
  loader: loaderId,
  url: Url.redact(url + urlFragment),
});

/**
 * What a page session's commit or move says of `page`'s main frame: a new document's `loader` and
 * its address, or a move's address; nothing for another frame. Only a commit is a new document:
 * `frameStartedLoading` also fires on `pushState`, a move within the document.
 */
export const mainFrame = (page: string, event: typeof MainFrameEvent.Type) =>
  "frame" in event
    ? event.frame.parentId === undefined
      ? commitOf(event.frame)
      : undefined
    : event.frameId === page
      ? { loader: undefined, url: Url.redact(event.url) }
      : undefined;

/** A call to the page script, its arguments quoted as JavaScript literals. */
export const scriptCall = (name: string, ...args: ReadonlyArray<unknown>): string =>
  `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

export const make = Effect.fnUntraced(function* (page: PageContext) {
  const { id, cdp, native, span, publish, now } = page;
  const { send } = page.protocol;
  // How far this session has registered: the script, then the recorder, which the first read of
  // changes asks for. One caller takes each step, once, while the others wait.
  const registration = yield* SynchronizedRef.make<"none" | "script" | "recorder">("none");
  // The current document's world, forgotten when the main frame commits another document; the
  // commits this session has seen, the latest marked on the page; and the page's address.
  let world: number | undefined;
  let documents = 0;
  let url = Url.redact(page.url);
  // The latest commits' loaders and the documents they began, newest last: a capture connection
  // sees the same commits, and numbers its frames by them.
  const loaders = new Map<string, number>();

  const onMainFrame = (event: typeof MainFrameEvent.Type) => {
    const seen = mainFrame(id, event);

    if (seen === undefined) return;
    if (seen.loader !== undefined) {
      documents++;
      loaders.delete(seen.loader);
      loaders.set(seen.loader, documents);
      const [oldest] = loaders.keys();

      if (loaders.size > 8 && oldest !== undefined) loaders.delete(oldest);
      page.activity.documentAt = now();
      world = undefined;
    }
    url = seen.url;
    const sameDocument = seen.loader === undefined;

    publish(new Navigated({ at: now(), page: id, url, document: documents, sameDocument }));
  };

  cdp.on("Page.frameNavigated", onMainFrame);
  cdp.on("Page.navigatedWithinDocument", onMainFrame);

  /**
   * The main-frame commits seen so far, once the Page domain, which registration turned on, has
   * answered, so that every later one counts. A commit within about one round trip of the count
   * can still be missed.
   */
  const currentDocument = (operation: string) =>
    page.paging(operation).pipe(Effect.map(() => documents));

  /** What a frame that arrives now shows: its session, the page's current document and address. */
  const frameTag = () => ({ session: page.session, document: documents, url });

  /** The document the main frame's latest commit of `loader` began, if this session counted it. */
  const documentOf = (loader: string) => loaders.get(loader);

  // The registration belongs to this session and the world to the page, so a session that attaches
  // later, as after a reconnect, registers again and finds the script already installed. With the
  // Page domain enabled, a source runs in each new document, in the order registered;
  // `runImmediately` runs it now.
  const addScript = (operation: string, source: string) =>
    native(operation, () =>
      send("Page.addScriptToEvaluateOnNewDocument", { source, worldName, runImmediately: true }),
    );

  const register = (operation: string) =>
    Effect.all(
      [
        page.paging(operation),
        addScript(operation, `if (globalThis === globalThis.top) ${installSource};`),
      ],
      { concurrency: "unbounded" },
    ).pipe(span("Page.register", {}, "Debug"));

  /** Take registration from `from` to `to` by `step`, unless it is past `from` already. */
  const advance = (
    from: "none" | "script",
    to: "script" | "recorder",
    step: Effect.Effect<unknown, BrowserError>,
  ) =>
    SynchronizedRef.updateEffect(registration, (state) =>
      state === from ? Effect.as(step, to) : Effect.succeed(state),
    );

  /** Register the script once, and the recorder after it once a read of changes asks for it. */
  const ensure = (operation: string, recorder: boolean) =>
    Effect.andThen(
      advance("none", "script", register(operation)),
      recorder ? advance("script", "recorder", addScript(operation, recorderSource)) : Effect.void,
    );

  const createWorld = (operation: string) =>
    Effect.gen(function* () {
      yield* ensure(operation, false);
      const document = documents;

      // The main frame's id is the page's target id.
      const created = yield* native(operation, () =>
        send("Page.createIsolatedWorld", { frameId: id, worldName }),
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
    native(operation, () =>
      send("Page.createIsolatedWorld", { frameId: id, worldName: `${worldName}-clock` }),
    ).pipe(Effect.map((created) => created.executionContextId));

  const run = (operation: string, expression: string, contextId: number) =>
    native(operation, () =>
      send("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true }),
    ).pipe(
      Effect.flatMap(({ result, exceptionDetails: thrown }) =>
        thrown === undefined
          ? Effect.succeed<unknown>(result.value)
          : failWith(
              operation,
              new Failed({ detail: thrown.exception?.description ?? thrown.text }),
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
        () => undispatched(operation, new Failed({ detail: missing })),
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

  return {
    current,
    bareWorld,
    evaluate,
    evaluateIn,
    evaluateWithContext,
    currentDocument,
    frameTag,
    documentOf,
    /** Register the recorder, so every later document records from its start. */
    registerRecorder: (operation: string) => ensure(operation, true),
  };
});

export type Bridge = Effect.Success<ReturnType<typeof make>>;
