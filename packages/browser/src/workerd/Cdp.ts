/**
 * CDP lifetime for Workers. The consumer supplies a runtime-compatible Playwright connector;
 * this entry imports no Playwright Node transport.
 *
 * @since 0.3.0
 */
import { make } from "../internal/cdp.ts";

export type { Connector, ConnectOptions, Options } from "../internal/cdp.ts";

export const { open, layer } = make();
