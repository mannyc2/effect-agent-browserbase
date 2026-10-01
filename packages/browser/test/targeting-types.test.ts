import { expect, it } from "@effect/vitest";
import type { Effect, Scope } from "effect";
import type { BrowserSession, Frame, Page, PageOperations } from "effect-browser/browser";
import type {
  FrameInfo,
  Observation,
  PageInfo,
  Target,
  TextResult,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import * as PageControl from "effect-browser/page-control";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const page = (session: BrowserSession, info: PageInfo) => session.page(info);

const frame = (page: Page, info: FrameInfo) => page.frame(info);

const framesOf = (page: Page) => page.listFrames();
const directRead = (session: BrowserSession) => session.initialPage.readText({});
const asOperations = (page: Page): PageOperations => page;
const create = (session: BrowserSession) => session.createPage();
const select = (session: BrowserSession, page: Page) => session.selectPage(page);

const removedInputs = (session: BrowserSession) => {
  // @ts-expect-error An issued Page is required; bare connection serials grant no target identity.
  void session.selectPage("page-1");
  // @ts-expect-error Copied page metadata is not an issued Page.
  void session.selectPage({ pageId: "page-1", targetId: "t", url: "", title: "", selected: false });
  // @ts-expect-error Closure checks the same PageInfo and native target identity as selection.
  void session.closePage("page-1");
  // @ts-expect-error Removed selected factories cannot manufacture Page authority.
  void session.bind();
  // @ts-expect-error Selection metadata cannot manufacture executable Page authority.
  void session.currentTarget;
};

const pageResult: Same<Effect.Success<ReturnType<typeof page>>, Page> = true;
const frameResult: Same<Effect.Success<ReturnType<typeof frame>>, Frame> = true;
const frameList: Same<Effect.Success<ReturnType<typeof framesOf>>, ReadonlyArray<FrameInfo>> = true;
const readResult: Same<Effect.Success<ReturnType<typeof directRead>>, TextResult> = true;
const readError: Same<Effect.Error<ReturnType<typeof directRead>>, BrowserError> = true;
const readServices: Same<Effect.Services<ReturnType<typeof directRead>>, never> = true;
const targetIdentity: Same<Page["identity"], Target> = true;
const createdResult: Same<Effect.Success<ReturnType<typeof create>>, Page> = true;
const selectedResult: Same<Effect.Success<ReturnType<typeof select>>, void> = true;

const issuedPage = (session: BrowserSession, info: PageInfo) => session.page(info);
const issuedFrame = (page: Page, info: FrameInfo) => page.frame(info);
const frameRead = (frame: Frame) => frame.observe();
const pageHold = (page: Page) => PageControl.suspend(page);
const pageCapture = (page: Page) => Capture.start(page);

const issuedPageContract: Same<
  ReturnType<typeof issuedPage>,
  Effect.Effect<Page, BrowserError>
> = true;

const issuedFrameContract: Same<
  ReturnType<typeof issuedFrame>,
  Effect.Effect<Frame, BrowserError>
> = true;

const frameReadContract: Same<
  ReturnType<typeof frameRead>,
  Effect.Effect<Observation, BrowserError>
> = true;

const frameReadinessError: Same<
  Effect.Error<ReturnType<Frame["ready"]>>,
  InitializationError
> = true;

const frameReadinessServices: Same<Effect.Services<ReturnType<Frame["ready"]>>, never> = true;

const frameNavigationScope: Same<
  Effect.Services<ReturnType<Frame["startNavigation"]>>,
  Scope.Scope
> = true;

const pageHoldError: Same<Effect.Error<ReturnType<typeof pageHold>>, BrowserError> = true;
const pageHoldServices: Same<Effect.Services<ReturnType<typeof pageHold>>, never> = true;
const pageCaptureError: Same<Effect.Error<ReturnType<typeof pageCapture>>, BrowserError> = true;
const pageCaptureScope: Same<Effect.Services<ReturnType<typeof pageCapture>>, Scope.Scope> = true;
const originalInitialPage: Same<BrowserSession["initialPage"], Page> = true;

it("issued Page and Frame operations retain typed errors and require Scope for owned work", () => {
  expect(
    issuedPageContract &&
      issuedFrameContract &&
      frameReadContract &&
      frameReadinessError &&
      frameReadinessServices &&
      frameNavigationScope &&
      pageHoldError &&
      pageHoldServices &&
      pageCaptureError &&
      pageCaptureScope &&
      originalInitialPage,
  ).toBe(true);
});

it("issued exact Page and Frame targets preserve the public Effect contract", () => {
  expect(
    pageResult &&
      frameResult &&
      frameList &&
      readResult &&
      readError &&
      readServices &&
      targetIdentity &&
      createdResult &&
      selectedResult,
  ).toBe(true);
  expect(typeof asOperations).toBe("function");
  expect(typeof removedInputs).toBe("function");
});
