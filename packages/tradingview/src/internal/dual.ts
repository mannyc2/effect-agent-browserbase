/** Functions of a chart's page, callable with the page first or, in a pipe, last. */
import { Function } from "effect";
import { isPage, type Page } from "effect-browser/Page";

export const onPage = <Args extends ReadonlyArray<unknown>, A>(
  f: (page: Page, ...args: Args) => A,
): { (...args: Args): (page: Page) => A; (page: Page, ...args: Args): A } =>
  Function.dual((args) => isPage(args[0]), f);
