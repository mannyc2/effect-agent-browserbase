/**
 * Keys and typing: a key chord held and released, each typed event, and the document a run of
 * keys must stay in.
 */
import { Duration, Effect } from "effect";

import { BrowserError, NotActionable } from "../../BrowserError.ts";
import type { PageContext } from "../page/context.ts";
import type { Dispatch } from "./dispatch.ts";
import * as Keys from "./keys.ts";
import type * as Replies from "./replies.ts";

export const make = (page: PageContext, dispatch: Dispatch) => {
  const { cdp, playwright, native } = page;
  const { stamp, inputCall, dispatchKey, dispatchText } = dispatch;

  // A multi-key action stops before its next key once the page has moved to another document.
  // This session counts main-frame commits as the browser reports them, so a key sent within
  // about one protocol round trip of a commit can still reach the new document.
  let documents = 0;
  let watchingDocuments = false;

  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId === undefined) documents++;
  });

  const currentDocument = (operation: string) =>
    Effect.suspend(() =>
      watchingDocuments
        ? Effect.void
        : native(operation, () => cdp.send("Page.enable")).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                watchingDocuments = true;
              }),
            ),
          ),
    ).pipe(Effect.map(() => documents));

  const sameDocument = (operation: string, since: number) =>
    Effect.suspend(() =>
      documents === since
        ? Effect.void
        : Effect.fail(
            new BrowserError({
              operation,
              reason: new NotActionable({
                detail: "the page moved to another document, so the remaining keys were not sent",
              }),
              dispatched: false,
            }),
          ),
    );

  const keyStroke = (
    operation: string,
    run: Replies.Run,
    parts: ReadonlyArray<string>,
    holdMillis = 0,
  ) =>
    Effect.gen(function* () {
      yield* inputCall(operation, run.reserve(parts.length * 2));
      for (const part of parts)
        yield* inputCall(
          operation,
          run.down(
            `playwright:${part}`,
            () => dispatchKey(part, "down", () => playwright.keyboard.down(part), run),
            () => dispatchKey(part, "up", () => playwright.keyboard.up(part), run),
          ),
        );
      if (holdMillis > 0) yield* Effect.sleep(Duration.millis(holdMillis));
      for (const part of parts.toReversed())
        yield* inputCall(operation, run.up(`playwright:${part}`));
    });

  const typeEvent = (
    run: Replies.Run,
    event: { readonly phase: "down" | "up" | "insert"; readonly key: string },
    secret: boolean,
  ) =>
    inputCall(
      "type",
      Effect.gen(function* () {
        if (event.phase === "insert") {
          yield* run.reserve(1);
          yield* run.send(() => dispatchText(event.key, secret));

          return;
        }

        const description = Keys.description(event.key);

        if (description === undefined) return yield* Effect.die("invalid planned key");
        const { key, code, keyCode, text } = description;
        const held = "raw:" + code;

        if (event.phase === "up") return yield* run.up(held);
        yield* run.reserve(2);
        yield* run.down(
          held,
          () =>
            dispatchKey(
              key,
              "down",
              (at, estimate) =>
                cdp.send("Input.dispatchKeyEvent", {
                  type: "keyDown",
                  ...stamp(estimate, at),
                  modifiers: 0,
                  windowsVirtualKeyCode: keyCode,
                  code,
                  commands: [],
                  key,
                  text,
                  unmodifiedText: text,
                  autoRepeat: false,
                  location: 0,
                  isKeypad: false,
                }),
              run,
              secret,
            ),
          () =>
            dispatchKey(
              key,
              "up",
              (at, estimate) =>
                cdp.send("Input.dispatchKeyEvent", {
                  type: "keyUp",
                  ...stamp(estimate, at),
                  modifiers: 0,
                  windowsVirtualKeyCode: keyCode,
                  code,
                  key,
                  location: 0,
                }),
              run,
              secret,
            ),
        );
      }),
    );

  return { currentDocument, sameDocument, keyStroke, typeEvent };
};

export type Keyboard = ReturnType<typeof make>;
