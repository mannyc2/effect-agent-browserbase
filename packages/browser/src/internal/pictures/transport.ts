/**
 * Where a page's screencast runs: on the page's own session, or on a capture connection that the
 * provider supplies, where frames and their acknowledgements never wait behind a large message on
 * the connection that drives the page. There the page's session attaches as its first capture
 * starts, with the Page domain on, and stays until the page closes or the session ends; the next
 * capture then attaches again.
 *
 * Frames take their document from the commits their own session reports, in the order the browser
 * sent them, so a frame never shows a document after the one it carries, as on the page's own
 * session. They are numbered as the page's own session counts documents: a commit it has counted
 * keeps its number, and one the capture connection sees first takes the next, until it is counted.
 */
import { Effect, Exit, Option, Schema, Scope } from "effect";

import type { CaptureSource } from "../../Browser.ts";
import { type BrowserError, Failed } from "../../BrowserError.ts";
import { type Bridge, Commit, commitOf, mainFrame, MainFrameEvent } from "../page/bridge.ts";
import { type PageContext, undispatched } from "../page/context.ts";

/** Where a capture's screencast runs. Its calls never throw: a failure rejects. */
export interface Transport {
  readonly start: (settings: {
    readonly format: "jpeg";
    readonly quality: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
  }) => Promise<unknown>;
  readonly acknowledge: (frame: number) => Promise<unknown>;
  readonly stop: () => Promise<unknown>;
  /**
   * A round trip whose answer comes behind every frame sent before it. On the page's own session,
   * the page's own calls are such round trips already, so it sends nothing.
   */
  readonly sync: () => Promise<unknown>;
  /**
   * Hand its frames to `on.frame` as they arrive, and its end to `on.lost` should it end, until
   * the returned function is called.
   */
  readonly listen: (on: {
    readonly frame: (frame: NativeFrame) => void;
    readonly lost: (error: BrowserError) => void;
  }) => () => void;
  /** What a frame arriving now shows: its session, the document it followed and the address then. */
  readonly frameTag: () => {
    readonly session: string;
    readonly document: number;
    readonly url: string;
  };
}

/** The page's own session. */
export const own = (page: PageContext, bridge: Bridge): Transport => {
  const { send } = page.protocol;

  return {
    start: (settings) => send("Page.startScreencast", settings),
    acknowledge: (frame) => send("Page.screencastFrameAck", { sessionId: frame }),
    stop: () => send("Page.stopScreencast"),
    sync: () => Promise.resolve(),
    listen: ({ frame }) => {
      page.cdp.on("Page.screencastFrame", frame);

      return () => {
        page.cdp.off("Page.screencastFrame", frame);
      };
    },
    frameTag: bridge.frameTag,
  };
};

const FrameTree = Schema.Struct({ frameTree: Schema.Struct({ frame: Commit }) });

/** A native screencast frame, as Chromium sends it. */
const ScreencastFrame = Schema.Struct({
  data: Schema.String,
  sessionId: Schema.Int,
  metadata: Schema.Struct({
    timestamp: Schema.optionalKey(Schema.Finite),
    deviceWidth: Schema.Finite,
    deviceHeight: Schema.Finite,
  }),
});

export type NativeFrame = typeof ScreencastFrame.Type;

/**
 * The document and address a capture connection's frames show, from the commits its session
 * reports after `first`, the main frame's document as the session began.
 */
const documents = (bridge: Bridge, first: ReturnType<typeof commitOf>) => {
  // The number the page's own session gave the latest commit of `loader`, if it has counted one.
  const counted = (loader: string) => bridge.documentOf(loader) ?? -1;
  const latest = bridge.frameTag().document;

  // A loader the page's own session hasn't counted began the document it had from the start, or
  // a commit still on its way to it.
  const shown = {
    ...first,
    document: counted(first.loader) >= 0 ? counted(first.loader) : latest === 0 ? 0 : latest + 1,
  };

  return {
    /** A commit or a move the session reported, in the order the browser sent them. */
    see: (seen: ReturnType<typeof mainFrame>) => {
      if (seen?.loader !== undefined) {
        shown.document = Math.max(shown.document + 1, counted(seen.loader));
        shown.loader = seen.loader;
      }
      if (seen !== undefined) shown.url = seen.url;
    },
    tag: () => {
      shown.document = Math.max(shown.document, counted(shown.loader));

      return { document: shown.document, url: shown.url };
    },
  };
};

type State =
  | { readonly _tag: "Detached" }
  | { readonly _tag: "Attaching"; readonly scope: Scope.Closeable }
  | { readonly _tag: "Attached"; readonly scope: Scope.Closeable; readonly transport: Transport }
  | { readonly _tag: "Ended"; readonly scope: Scope.Closeable; readonly error: BrowserError };

/**
 * The page's session on the capture connection, attached when a capture asks for it and kept for
 * the page's scope. Its state changes only here: attaching, attached, or ended by the session's
 * end, which also ends the capture listening to it.
 */
export const apart = (
  page: PageContext,
  bridge: Bridge,
  source: CaptureSource,
  error: (cause: unknown) => BrowserError,
  pageScope: Scope.Scope,
): Effect.Effect<Transport, BrowserError> => {
  let state: State = { _tag: "Detached" };
  let listening: Parameters<Transport["listen"]>[0] | undefined;
  const latest = (): State => state;

  const end = (scope: Scope.Closeable, ended: BrowserError) => {
    if ((state._tag !== "Attaching" && state._tag !== "Attached") || state.scope !== scope) return;
    const attached = state._tag === "Attached";

    state = { _tag: "Ended", scope, error: ended };
    if (attached) listening?.lost(ended);
  };

  const unreadable = undispatched(
    "screencast",
    new Failed({ detail: "the capture connection sent an event it could not read" }),
  );

  const attach = (scope: Scope.Closeable) =>
    Effect.gen(function* () {
      let shown: ReturnType<typeof documents> | undefined;

      // Commits before the frame tree's answer are in it already.
      const event = (method: string, params: unknown) => {
        const decoded = <A>(schema: Schema.Codec<A, unknown>, act: (value: A) => void) =>
          Option.match(Schema.decodeUnknownOption(schema)(params), {
            onNone: () => end(scope, unreadable),
            onSome: act,
          });

        if (method === "Page.screencastFrame")
          decoded(ScreencastFrame, (frame: NativeFrame) => listening?.frame(frame));
        else if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument")
          decoded(MainFrameEvent, (event) => shown?.see(mainFrame(page.id, event)));
        else if (method === "Target.detachedFromTarget")
          end(scope, error(new Error("Target page has been closed")));
      };

      const send = yield* source.attach(page.id, { event, lost: (lost) => end(scope, lost) });

      // Tracked from the frame tree's answer on, set as it arrives so that no commit after it is
      // missed.
      const tracked = yield* Effect.tryPromise({
        try: () =>
          Promise.all([send("Page.enable"), send("Page.getFrameTree")]).then(([, tree]) =>
            Option.match(Schema.decodeUnknownOption(FrameTree)(tree), {
              onNone: () => Promise.reject(unreadable),
              onSome: ({ frameTree }) => (shown = documents(bridge, commitOf(frameTree.frame))),
            }),
          ),
        catch: error,
      });

      return {
        start: (settings) => send("Page.startScreencast", settings),
        acknowledge: (frame) => send("Page.screencastFrameAck", { sessionId: frame }),
        stop: () => send("Page.stopScreencast"),
        sync: () => send("Page.getFrameTree"),
        listen: (on) => {
          listening = on;

          return () => {
            if (listening === on) listening = undefined;
          };
        },
        frameTag: () => ({ session: page.session, ...tracked.tag() }),
      } satisfies Transport;
    }).pipe(Scope.provide(scope));

  const current: Effect.Effect<Transport, BrowserError> = Effect.suspend(() => {
    switch (state._tag) {
      case "Attached":
        return Effect.succeed(state.transport);
      case "Ended": {
        const { scope } = state;

        state = { _tag: "Detached" };

        return Scope.close(scope, Exit.void).pipe(Effect.andThen(current));
      }
      case "Detached":
      case "Attaching":
        return Effect.gen(function* () {
          const scope = yield* Scope.fork(pageScope);

          state = { _tag: "Attaching", scope };
          const attached = yield* Effect.exit(attach(scope).pipe(page.within("screencast")));
          // `end` may have changed it meanwhile.
          const settled = latest();

          // A session that ended as it attached is never handed out.
          if (Exit.isSuccess(attached) && settled._tag === "Attaching" && settled.scope === scope) {
            state = { _tag: "Attached", scope, transport: attached.value };

            return attached.value;
          }
          state = { _tag: "Detached" };
          yield* Scope.close(scope, Exit.void);
          if (Exit.isFailure(attached)) return yield* attached;

          return yield* settled._tag === "Ended" ? settled.error : unreadable;
        });
    }
  });

  return current;
};
