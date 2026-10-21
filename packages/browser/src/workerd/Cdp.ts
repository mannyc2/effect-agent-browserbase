/**
 * CDP lifetime for Workers. The consumer supplies a runtime-compatible Playwright connector;
 * this entry imports no Playwright Node transport.
 *
 * @since 0.3.0
 */
import { make } from "../providers/connection.ts";

export type { Connector, ConnectOptions, Options } from "../providers/connection.ts";

export const { open, layer } = make();
