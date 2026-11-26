/**
 * A browser reached over Chrome DevTools Protocol. Node defaults to Playwright's transport;
 * `connect` supplies another runtime's real Playwright browser. Closing the scope disconnects.
 *
 * @stability stable
 * @since 0.3.0
 */
import { chromium } from "playwright-core";

import { make } from "./internal/cdp/connection.ts";

export type {
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  Connector,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  ConnectOptions,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  Options,
} from "./internal/cdp/connection.ts";

/**
 * Connect and open a `Browser` over the endpoint's first context.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const { open, layer } = make((endpoint, options) =>
  chromium.connectOverCDP(endpoint, options),
);
