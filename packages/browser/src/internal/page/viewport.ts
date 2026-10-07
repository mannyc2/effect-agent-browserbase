/**
 * The viewport's size in CSS pixels. Playwright knows it only for a context it created; over CDP it
 * reports none, so the page answers. Pointer bounds, page scrolls, crops, capture size and frame
 * reuse all read this one source; the latest answer serves checks that cannot wait for the page.
 */
import { Effect } from "effect";

import { ViewportResultSchema } from "../reading/outline.inpage.ts";
import { type Bridge, scriptCall } from "./bridge.ts";
import { decodeWith, type PageContext } from "./context.ts";

export const make = (page: PageContext, bridge: Bridge) => {
  const { playwright } = page;
  let measuredViewport: { readonly width: number; readonly height: number } | null = null;

  const knownViewport = () => playwright.viewportSize() ?? measuredViewport;

  const viewportFor = (operation: string) =>
    Effect.suspend(() => {
      const known = playwright.viewportSize();

      return known === null
        ? bridge.evaluate(operation, scriptCall("viewport")).pipe(
            Effect.flatMap(decodeWith(operation, ViewportResultSchema)),
            Effect.tap((measured) =>
              Effect.sync(() => {
                measuredViewport = measured;
              }),
            ),
          )
        : Effect.succeed(known);
    });

  return { knownViewport, viewportFor };
};

export type Viewport = ReturnType<typeof make>;
