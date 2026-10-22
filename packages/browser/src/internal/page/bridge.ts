/**
 * The bridge to the page script, and the page's documents as its own session sees them commit and
 * load, so a load follows its commit. At the library's first read of a page, its own protocol
 * session registers the script, so every later document runs it in an isolated world from its
 * start; calls go to the current document's world. The script is composed from the domains'
 * page-side parts, the `*.inpage.ts` modules, in the order they depend on one another. At the first
 * read of a page's changes, its session registers the recorder too, so every later document
 * records from its start.
 */
import { Deferred, Effect, Schema, SynchronizedRef } from "effect";

import { type BrowserError, Failed } from "../../BrowserError.ts";
import { Navigated, PageLoaded } from "../../BrowserEvent.ts";
import { match } from "../../Matching.ts";
import * as Url from "../../Url.ts";
import { edit, type Edit } from "../input/edit.inpage.ts";
import { evidence } from "../input/evidence.inpage.ts";
import { guard, type Guard } from "../input/guard.inpage.ts";
import { targets, type Targets } from "../input/targets.inpage.ts";
import { context } from "../reading/context.inpage.ts";
import { controls } from "../reading/controls.inpage.ts";
import { expectations, type Expectations } from "../reading/expect.inpage.ts";
import { elements, names } from "../reading/names.inpage.ts";
import { outline, type Outline } from "../reading/outline.inpage.ts";
import { ready } from "../reading/ready.inpage.ts";
import { states, subjects, type Subjects } from "../reading/subjects.inpage.ts";
import { text, type Texts } from "../reading/text.inpage.ts";
import { walk } from "../reading/walk.inpage.ts";
import { changes, type Changes } from "../timeline/changes.inpage.ts";
import { fold } from "../timeline/fold.inpage.ts";
import { history } from "../timeline/history.inpage.ts";
import { marks } from "../timeline/marks.inpage.ts";
import { record, type Recorder } from "../timeline/record.inpage.ts";
import { sight } from "../timeline/sight.inpage.ts";
import { contextGone, decodeWith, failWith, type PageContext } from "./context.ts";
import { Script } from "./port.ts";

/** What the script installs: a version, and a function of one of its parts for each call. */
export interface PageApi {
  readonly version: number;
  readonly refs: { next: number };
  dispose: () => void;
  snapshot: Outline["snapshot"];
  find: Subjects["find"];
  until: Expectations["until"];
  text: Texts["read"];
  record: Recorder["start"];
  stopRecord: Recorder["stop"];
  changes: Changes["read"];
  ready: ReturnType<typeof ready>["wait"];
  settle: ReturnType<typeof ready>["settle"];
  point: Targets["point"];
  scrollPlan: Targets["scrollPlan"];
  viewport: Outline["viewport"];
  /** The screen as the page reads it, which another session may emulate. */
  screenSize: () => { readonly width: number; readonly height: number };
  prepareInput: Guard["prepareInput"];
  validateInput: Guard["validateInput"];
  typeable: Edit["typeable"];
  focus: Edit["focus"];
  focusOn: Edit["focusOn"];
  select: Edit["select"];
}

declare global {
  // The API this script installs, which exists only inside the library's isolated world.
  var __effectBrowser: PageApi | undefined;
}

/** Named factories make the composition contract independent of their declaration order. */
export const parts = {
  elements,
  names,
  walk,
  match,
  context,
  subjects,
  states,
  expectations,
  text,
  controls,
  fold,
  history,
  sight,
  marks,
  record,
  changes,
  ready,
  outline,
  targets,
  evidence,
  guard,
  edit,
  addresses: Url.addresses,
};

// Like the parts it receives, this is evaluated from its source text. The named function also
// hashes its own source, so changing the composition invalidates an installation too.
type Parts = typeof parts;

export function install(parts: Parts): PageApi {
  const source =
    install.toString() +
    Object.entries(parts)
      .map(([name, factory]) => name + factory.toString())
      .join("");

  let version = 0x811c9dc5;

  for (let index = 0; index < source.length; index++)
    version = Math.imul(version ^ source.charCodeAt(index), 0x01000193);
  version >>>= 0;
  const installed = globalThis.__effectBrowser;

  if (installed !== undefined && installed.version === version) return installed;
  installed?.dispose?.();
  const named = parts.names(parts.elements());

  if (installed?.refs !== undefined) named.refs.next = installed.refs.next;
  const walked = parts.walk(named);
  const placing = parts.context(named, walked);
  const matching = parts.match();
  const subjected = parts.subjects(named, walked, matching, placing, parts.states(named));
  const texts = parts.text(named, walked);
  const controlled = parts.controls(named, subjected, texts);
  const kept = parts.history(parts.fold());
  const seeing = parts.sight(named, walked, texts, kept);
  const marking = parts.marks(named, kept, seeing);
  const recorder = parts.record(named, texts, kept, seeing, marking);
  const read = parts.outline(named, walked, subjected, texts, controlled, parts.addresses());
  const located = parts.targets(named, walked, placing);
  const guarded = parts.guard(named, located, parts.evidence(named, placing));
  const edited = parts.edit(named, guarded, placing);
  const readiness = parts.ready(walked, texts, kept);

  const api: PageApi = {
    version,
    refs: named.refs,
    dispose: () => recorder.stop(),
    snapshot: read.snapshot,
    find: subjected.find,
    until: parts.expectations(named, subjected, matching).until,
    text: texts.read,
    record: recorder.start,
    stopRecord: recorder.stop,
    changes: parts.changes(named, placing, kept, seeing, marking, recorder).read,
    ready: readiness.wait,
    settle: readiness.settle,
    point: located.point,
    scrollPlan: located.scrollPlan,
    viewport: read.viewport,
    screenSize: () => ({ width: screen.width, height: screen.height }),
    prepareInput: guarded.prepareInput,
    validateInput: guarded.validateInput,
    typeable: edited.typeable,
    focus: edited.focus,
    focusOn: edited.focusOn,
    select: edited.select,
  };

  globalThis.__effectBrowser = api;

  return api;
}

/** The expression that installs the script and evaluates to its API; packaging freezes it. */
export const installSource = `(${install.toString()})({${Object.entries(parts)
  .map(([name, factory]) => `${name}: ${factory.toString()}`)
  .join(", ")}})`;

const worldName = "effect-browser";

// What starts the recorder in each new document, after the script installed itself there.
const recorderSource = `if (globalThis === globalThis.top) globalThis.__effectBrowser?.record();`;

// What a call reads in a world without the script's API. A context id can name another world once
// the page has moved to a new process, so a cached id that reads this is not the library's world.
const missing = "effect-browser: no __effectBrowser in this world";
const missingSource = Schema.encodeSync(Schema.fromJsonString(Schema.String))(missing);

const isMissing = (error: BrowserError) =>
  error.reason._tag === "Failed" && error.reason.detail === missing;

const Evaluated = Schema.Struct({
  value: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
  nextRef: Schema.Finite,
});

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

const runIn = (page: PageContext, operation: string, expression: string, contextId: number) =>
  page
    .native(operation, () =>
      page.protocol.send("Runtime.evaluate", {
        contextId,
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    )
    .pipe(
      Effect.flatMap(({ result, exceptionDetails: thrown }) =>
        thrown === undefined
          ? Effect.succeed<unknown>(result.value)
          : failWith(
              operation,
              new Failed({ detail: thrown.exception?.description ?? thrown.text }),
            ),
      ),
    );

/** Session-owned registrations; the recorder can expire independently of the page script. */
const registrationFor = Effect.fnUntraced(function* (page: PageContext) {
  const { native, span } = page;
  const { send } = page.protocol;

  // How far this session has registered: the script, then the recorder, which the first read of
  // changes asks for. One caller takes each step, once, while the others wait.
  const registration = yield* SynchronizedRef.make<{
    readonly script: boolean;
    readonly recorder?: string | undefined;
  }>({ script: false });

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

  /** Register the script once; the change-reader lifetime owns its removable registration. */
  const ensure = (operation: string, recorder: boolean) =>
    SynchronizedRef.updateEffect(registration, (state) =>
      Effect.gen(function* () {
        if (!state.script) yield* register(operation);
        if (recorder && state.recorder === undefined) {
          const registered = yield* addScript(operation, recorderSource);

          return { script: true, recorder: registered.identifier };
        }

        return { ...state, script: true };
      }),
    );

  const removeRecorder = (operation: string) =>
    SynchronizedRef.updateEffect(registration, (state) => {
      const identifier = state.recorder;

      return identifier === undefined
        ? Effect.succeed(state)
        : native(operation, () =>
            send("Page.removeScriptToEvaluateOnNewDocument", { identifier }),
          ).pipe(Effect.as({ script: true }));
    });

  return { ensure, removeRecorder };
});

export const make = Effect.fnUntraced(function* (page: PageContext) {
  const { id, cdp, native, span, publish, now } = page;
  const { send } = page.protocol;
  const { ensure, removeRecorder } = yield* registrationFor(page);

  // The current document's world, forgotten when the main frame commits another document; the
  // commits this session has seen, the latest marked on the page; the page's address; and how far
  // the current document has loaded.
  let world: number | undefined;
  let documents = 0;
  let nextDocument = Deferred.makeUnsafe<void>();
  let url = Url.redact(page.url);
  let loaded: PageLoaded | undefined;
  // Every script call can allocate refs (including guards and point input), so the bridge,
  // rather than individual readers, owns the floor across the page's documents.
  let nextRef = 1;
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
      loaded = undefined;
      Deferred.doneUnsafe(nextDocument, Effect.void);
      nextDocument = Deferred.makeUnsafe<void>();
    }
    url = seen.url;
    const sameDocument = seen.loader === undefined;

    publish(new Navigated({ at: now(), page: id, url, document: documents, sameDocument }));
  };

  // The session tells these of the main frame alone.
  const onLoaded = (state: PageLoaded["state"]) => () => {
    loaded = new PageLoaded({ at: now(), page: id, state });
    publish(loaded);
  };

  cdp.on("Page.frameNavigated", onMainFrame);
  cdp.on("Page.navigatedWithinDocument", onMainFrame);
  cdp.on("Page.domContentEventFired", onLoaded("domcontentloaded"));
  cdp.on("Page.loadEventFired", onLoaded("load"));

  /**
   * The main-frame commits seen so far, once the Page domain, which registration turned on, has
   * answered, so that every later one counts. A commit within about one round trip of the count
   * can still be missed.
   */
  const currentDocument = (operation: string) =>
    page.paging(operation).pipe(Effect.map(() => documents));

  /** What a frame that arrives now shows: its session, the page's current document and address. */
  const frameTag = () => ({
    session: page.session,
    connection: page.connection,
    document: documents,
    url,
  });

  /** The document the main frame's latest commit of `loader` began, if this session counted it. */
  const documentOf = (loader: string) => loaders.get(loader);

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
    runIn(page, operation, expression, contextId);

  const evaluateIn = (operation: string, call: string, contextId: number) =>
    Effect.gen(function* () {
      const result = yield* run(
        operation,
        `(async () => {
        const api = globalThis.__effectBrowser;
        if (api === undefined) return ${missingSource};
        api.refs.next = Math.max(api.refs.next, ${nextRef});
        try { return { value: await globalThis.__effectBrowser.${call}, nextRef: api.refs.next }; }
        catch (error) { return { error: error instanceof Error ? error.message : String(error), nextRef: api.refs.next }; }
      })()`,
        contextId,
      );

      if (result === missing) return yield* failWith(operation, new Failed({ detail: missing }));
      const evaluated = yield* decodeWith(operation, Evaluated)(result);

      nextRef = Math.max(nextRef, evaluated.nextRef);

      return evaluated.error === undefined
        ? evaluated.value
        : yield* failWith(operation, new Failed({ detail: evaluated.error }));
    }).pipe(
      // One round trip to the page. Its arguments can hold typed text, so only the call is named.
      span("Page.evaluate", { function: call.split("(")[0] }, "Trace"),
      Effect.provideService(Script, call.split("(")[0]),
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
    /** Wait for the owning protocol session to observe a replacement before retrying its read. */
    waitForDocument: (before: number) =>
      Effect.suspend(() => (documents === before ? Deferred.await(nextDocument) : Effect.void)),
    frameTag,
    documentOf,
    /** How far the current document has loaded, as this session heard; nothing until parsed. */
    loaded: () => loaded,
    /** Register the recorder, so every later document records from its start. */
    registerRecorder: (operation: string) => ensure(operation, true),
    /** Stop future documents and the current recorder at the host idle deadline. */
    unregisterRecorder: (operation: string) =>
      removeRecorder(operation).pipe(Effect.andThen(evaluate(operation, scriptCall("stopRecord")))),
  };
});

export type Bridge = Effect.Success<ReturnType<typeof make>>;
