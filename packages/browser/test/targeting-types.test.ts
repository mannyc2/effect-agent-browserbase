import { expect, it } from "@effect/vitest";
import type { Effect } from "effect";
import type {
  BrowserSession,
  TargetOperations,
  RetainedTarget,
  PinnedTarget,
} from "effect-browser/browser";
import type { FrameInfo, PageInfo, Target, TextResult } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const pinPage = (session: BrowserSession, page: PageInfo) => session.pinPage(page);

const pinFrame = (session: BrowserSession, page: PageInfo, frame: FrameInfo) =>
  session.pinFrame(page, frame);

const framesOf = (session: BrowserSession, page: PageInfo) => session.framesOf(page);
const directRead = (session: BrowserSession) => session.readText({});
const asOperations = (session: BrowserSession): TargetOperations => session;
const retain = (session: BrowserSession) => session.retain;
const create = (session: BrowserSession) => session.createPage;
const select = (session: BrowserSession, page: PageInfo) => session.selectPage(page);

const removedInputs = (session: BrowserSession) => {
  // @ts-expect-error Page metadata is required; bare connection serials grant no target identity.
  void session.selectPage("page-1");
  // @ts-expect-error Closure checks the same PageInfo and native target identity as selection.
  void session.closePage("page-1");
  // @ts-expect-error Retention is an admitted Effect, not an unchecked synchronous factory.
  void session.bind();
  // @ts-expect-error Current operations and checked retention have separate explicit APIs.
  void session.currentTarget;
};

const pageResult: Same<Effect.Success<ReturnType<typeof pinPage>>, PinnedTarget> = true;
const frameResult: Same<Effect.Success<ReturnType<typeof pinFrame>>, PinnedTarget> = true;
const frameList: Same<Effect.Success<ReturnType<typeof framesOf>>, ReadonlyArray<FrameInfo>> = true;
const readResult: Same<Effect.Success<ReturnType<typeof directRead>>, TextResult> = true;
const readError: Same<Effect.Error<ReturnType<typeof directRead>>, BrowserError> = true;
const readServices: Same<Effect.Services<ReturnType<typeof directRead>>, never> = true;
const targetIdentity: Same<PinnedTarget["target"], Target> = true;
const retainedResult: Same<Effect.Success<ReturnType<typeof retain>>, RetainedTarget> = true;
const retainedError: Same<Effect.Error<ReturnType<typeof retain>>, BrowserError> = true;
const retainedServices: Same<Effect.Services<ReturnType<typeof retain>>, never> = true;
const createdResult: Same<Effect.Success<ReturnType<typeof create>>, PageInfo> = true;
const selectedResult: Same<Effect.Success<ReturnType<typeof select>>, void> = true;

it("direct selected operations and pinned targets preserve the public Effect contract", () => {
  expect(
    pageResult &&
      frameResult &&
      frameList &&
      readResult &&
      readError &&
      readServices &&
      targetIdentity &&
      retainedResult &&
      retainedError &&
      retainedServices &&
      createdResult &&
      selectedResult,
  ).toBe(true);
  expect(typeof asOperations).toBe("function");
  expect(typeof removedInputs).toBe("function");
});
