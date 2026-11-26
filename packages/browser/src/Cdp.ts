/**
 * A browser reached over Chrome DevTools Protocol. Node defaults to Playwright's transport;
 * `connect` supplies another runtime's real Playwright browser. Closing the scope disconnects.
 *
 * @since 0.3.0
 */
import { chromium } from "playwright-core";

import { forRuntime } from "./internal/cdp/connection.ts";

export type { Connector, ConnectOptions, Options } from "./internal/cdp/connection.ts";

/** Connect and open a `Browser` over the endpoint's first context, as an effect or a layer. */
export const { make, layer, layerConfig } = forRuntime((endpoint, options) =>
  chromium.connectOverCDP(endpoint, options),
);
