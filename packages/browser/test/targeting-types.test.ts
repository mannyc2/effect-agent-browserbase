import { expect, it } from "@effect/vitest";
import type { Effect } from "effect";
import type { BrowserSession, BoundTarget, PinnedTarget } from "effect-browser/browser";
import type { FrameInfo, PageInfo, Target, TextResult } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const pinPage = (session: BrowserSession, page: PageInfo) => session.pinPage(page);

const pinFrame = (session: BrowserSession, page: PageInfo, frame: FrameInfo) =>
  session.pinFrame(page, frame);

const framesOf = (session: BrowserSession, page: PageInfo) => session.framesOf(page);
const directRead = (session: BrowserSession) => session.readText({});
const asBound = (session: BrowserSession): BoundTarget => session;

const pageResult: Same<Effect.Success<ReturnType<typeof pinPage>>, PinnedTarget> = true;
const frameResult: Same<Effect.Success<ReturnType<typeof pinFrame>>, PinnedTarget> = true;
const frameList: Same<Effect.Success<ReturnType<typeof framesOf>>, ReadonlyArray<FrameInfo>> = true;
const readResult: Same<Effect.Success<ReturnType<typeof directRead>>, TextResult> = true;
const readError: Same<Effect.Error<ReturnType<typeof directRead>>, BrowserError> = true;
const readServices: Same<Effect.Services<ReturnType<typeof directRead>>, never> = true;
const targetIdentity: Same<PinnedTarget["target"], Target> = true;

it("direct selected operations and pinned targets preserve the public Effect contract", () => {
  expect(
    pageResult &&
      frameResult &&
      frameList &&
      readResult &&
      readError &&
      readServices &&
      targetIdentity,
  ).toBe(true);
  expect(typeof asBound).toBe("function");
});
