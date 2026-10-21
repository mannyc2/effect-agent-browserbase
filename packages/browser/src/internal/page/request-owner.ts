/** Proves a paused request's context before the connection's policy may see it. */
import { Clock, Effect, Option, Schema } from "effect";
import type { BrowserContext, CDPSession } from "playwright-core";

import { type BrowserError, InvalidRequest, undispatched } from "../../BrowserError.ts";
import * as Port from "./port.ts";

export type Native = <A>(
  run: (signal: AbortSignal) => Promise<A>,
  closing?: boolean,
) => Effect.Effect<A, BrowserError>;

interface Tree {
  readonly frame: { readonly id: string };
  readonly childFrames?: ReadonlyArray<Tree> | undefined;
}

const Tree: Schema.Codec<Tree> = Schema.Struct({
  frame: Schema.Struct({ id: Schema.String }),
  childFrames: Schema.optional(Schema.Array(Schema.suspend(() => Tree))),
});

const FrameTree = Schema.Struct({ frameTree: Tree });

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Finite),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Struct({ message: Schema.String })),
  }),
);

const contains = (tree: Tree, frame: string): boolean =>
  tree.frame.id === frame || tree.childFrames?.some((child) => contains(child, frame)) === true;

const queryTree = async (
  chrome: CDPSession,
  target: string,
  signal: AbortSignal,
  session: Port.Session,
  hooks: Port.Hooks,
) => {
  const { sessionId } = await chrome.send("Target.attachToTarget", {
    targetId: target,
    flatten: false,
  });

  if (signal.aborted) {
    await chrome.send("Target.detachFromTarget", { sessionId });
    throw new Error("request ownership query was interrupted");
  }

  const response = Promise.withResolvers<unknown>();
  const interruption = Promise.withResolvers<never>();

  const receive = (event: { sessionId: string; message: string }) => {
    if (event.sessionId !== sessionId) return;
    const reply = Schema.decodeOption(Reply)(event.message);

    if (Option.isNone(reply)) {
      response.reject(new Error("request ownership query received an invalid response"));

      return;
    }
    if (reply.value.id !== 1) return;
    if (reply.value.error !== undefined) response.reject(new Error(reply.value.error.message));
    else response.resolve(reply.value.result);
  };

  const detached = (event: { sessionId: string }) => {
    if (event.sessionId === sessionId)
      interruption.reject(new Error("request ownership target detached"));
  };

  const aborted = () => interruption.reject(new Error("request ownership query was interrupted"));

  chrome.on("Target.receivedMessageFromTarget", receive);
  chrome.on("Target.detachedFromTarget", detached);
  signal.addEventListener("abort", aborted, { once: true });

  try {
    const send = () => {
      void chrome
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id: 1, method: "Page.getFrameTree" }),
        })
        .catch(response.reject);

      return response.promise;
    };

    // The logical child command stays faultable without inspecting serialized CDP messages.
    const query = hooks.query;

    return await Promise.race([
      query === undefined ? send() : query(session, "Page.getFrameTree", send),
      interruption.promise,
    ]);
  } finally {
    chrome.off("Target.receivedMessageFromTarget", receive);
    chrome.off("Target.detachedFromTarget", detached);
    signal.removeEventListener("abort", aborted);
    await chrome.send("Target.detachFromTarget", { sessionId });
  }
};

export const make = Effect.fnUntraced(function* (
  context: BrowserContext,
  chrome: CDPSession,
  native: Native,
) {
  const clock = yield* Clock.Clock;
  const hooks = yield* Port.Current;
  const protocol = yield* Effect.context<never>();

  const owned = yield* native(async (signal) => {
    const existing = context.pages()[0];
    const page = existing ?? (await context.newPage());
    let cdp: CDPSession | undefined;

    try {
      if (signal.aborted) throw new Error("request ownership setup was interrupted");
      cdp = await Effect.runPromiseWith(protocol)(
        Port.openSession(
          async () => {
            if (signal.aborted) throw new Error("request ownership setup was interrupted");
            const created = await context.newCDPSession(page);

            if (signal.aborted) {
              await created.detach();
              throw new Error("request ownership setup was interrupted");
            }

            cdp = created;

            return created;
          },
          page,
          "browser",
        ),
        { signal },
      );
      if (signal.aborted) throw new Error("request ownership setup was interrupted");
      const { targetInfo } = await cdp.send("Target.getTargetInfo");

      if (targetInfo.browserContextId === undefined)
        throw new Error("request ownership requires an identifiable browser context");

      return targetInfo.browserContextId;
    } finally {
      try {
        if (cdp !== undefined) await cdp.detach();
      } finally {
        if (existing === undefined) await page.close();
      }
    }
  });

  const assertSupported = native(() => chrome.send("Target.getTargets")).pipe(
    Effect.flatMap(({ targetInfos }) =>
      targetInfos.some(
        (target) =>
          target.browserContextId === owned &&
          ["worker", "shared_worker", "service_worker"].includes(target.type),
      )
        ? undispatched(
            "requests",
            new InvalidRequest({
              detail: "request policies cannot protect preexisting workers in this context",
            }),
          )
        : Effect.void,
    ),
  );

  const owns = (frame: string | undefined, closing = false) =>
    native(async (signal) => {
      if (frame === undefined) throw new Error("request has no frame ownership evidence");

      const direct = await chrome
        .send("Target.getTargetInfo", { targetId: frame })
        .catch((cause: unknown) => {
          if (cause instanceof Error && /No target with given id found/.test(cause.message))
            return undefined;

          throw cause;
        });

      if (signal.aborted) throw new Error("request ownership query was interrupted");

      if (direct?.targetInfo.browserContextId !== undefined)
        return direct.targetInfo.browserContextId === owned
          ? { page: direct.targetInfo.type === "page" ? direct.targetInfo.targetId : undefined }
          : false;
      const { targetInfos } = await chrome.send("Target.getTargets");

      for (const target of targetInfos) {
        if (signal.aborted) throw new Error("request ownership query was interrupted");
        if (target.type !== "page") continue;

        const result = await queryTree(
          chrome,
          target.targetId,
          signal,
          {
            channel: "browser",
            page: target.targetId,
            clock,
          },
          hooks,
        );

        const { frameTree } = Schema.decodeUnknownSync(FrameTree)(result);

        if (contains(frameTree, frame)) {
          if (target.browserContextId === undefined)
            throw new Error("request frame has no browser context evidence");

          return target.browserContextId === owned ? { page: frameTree.frame.id } : false;
        }
      }

      throw new Error("request frame ownership could not be established");
    }, closing);

  const closeOwned = native(async (signal) => {
    while (true) {
      if (signal.aborted) throw new Error("request owner closure was interrupted");
      const { targetInfos } = await chrome.send("Target.getTargets");
      const targets = targetInfos.filter((target) => target.browserContextId === owned);

      if (targets.length === 0) return;
      for (const target of targets) {
        if (signal.aborted) throw new Error("request owner closure was interrupted");
        const { success } = await chrome.send("Target.closeTarget", { targetId: target.targetId });

        if (!success) throw new Error("request owner target did not confirm closure");
      }
    }
  }, true);

  return { owns, closeOwned, assertSupported };
});
