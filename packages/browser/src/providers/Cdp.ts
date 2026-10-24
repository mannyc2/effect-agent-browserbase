/**
 * A browser reached over Chrome DevTools Protocol. Node defaults to Playwright's transport;
 * `connect` supplies another runtime's real Playwright browser. Closing the scope disconnects.
 *
 * @since 0.3.0
 */
import { chromium } from "playwright-core";

import { make } from "./connection.ts";

export type { Connector, ConnectOptions, Options } from "./connection.ts";

/** Connect and open a `Browser` over the endpoint's first context. */
export const { open, layer } = make((endpoint, options) =>
  chromium.connectOverCDP(endpoint, options),
);
