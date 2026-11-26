/**
 * CDP lifetime for Workers. The consumer supplies a runtime-compatible Playwright connector;
 * this entry imports no Playwright Node transport.
 *
 * @since 0.3.0
 */
import { make } from "./connection.ts";

export type { Connector, ConnectOptions, Options } from "./connection.ts";

export const { open, layer } = make();
