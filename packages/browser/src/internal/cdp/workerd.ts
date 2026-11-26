/**
 * CDP lifetime for Workers. The consumer supplies a runtime-compatible Playwright connector;
 * this entry imports no Playwright Node transport.
 *
 * @stability stable
 * @since 0.3.0
 */
import { make } from "./connection.ts";

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
} from "./connection.ts";

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const { open, layer } = make();
