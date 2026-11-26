/**
 * A walk recorded once from a page's events and replayed later, on a fresh page, with no model
 * call.
 *
 * `fromEvents` keeps one page's completed actions with their subjects and the options they were
 * given, its navigations with both the address asked for and the one reached, and what was typed
 * as a named input slot, never the text itself. A navigation to an address whose credentials the
 * events withheld is an input slot too, so replay goes where the caller says, or nowhere, and
 * never to the address without them. `replay` takes the steps in turn. Before a step
 * except an opening navigate, back or reload, it waits for `Page.ready`; then it finds the element its
 * subject names, by role and name among those that repeat all its recorded context, and acts on
 * it. Text typed into focus was typed into the focused field, which replay finds the same way, and
 * text typed into a secret field goes into nothing else. An element step never falls back to
 * coordinates, and a step recorded at a point acts there only while the element found for it still
 * covers that point. `step` and `replay` return receipts; failure preserves a stopping point and
 * earlier receipts. Unknown consequential input is never resent. Only a positive durable read-back
 * can reconcile it; restoration follows the same rule. The consumer journals begun steps before
 * calling, treating interruption or a missing receipt as unknown. Version 3 carries canonical typed
 * Actions. Prior string-action plans and unknown versions do not decode.
 *
 * @stability stable
 * @since 0.3.0
 */
export {
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  Expected,
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  Step,
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  Walk,
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  Receipt,
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  Stopped,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Uncertain,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  ReplayError,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  ReplayErrorReason,
  /**
   * @stability stable
   * @category guards
   * @since 0.3.0
   */
  isReplayError,
  /**
   * @stability stable
   * @category guards
   * @since 0.3.0
   */
  isReplayErrorReason,
} from "./internal/data.ts";

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export { fromEvents } from "./internal/record.ts";

/**
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export { locate } from "./internal/targets.ts";

export {
  /**
   * @stability stable
   * @category combinators
   * @since 0.3.0
   */
  replay,
  /**
   * @stability stable
   * @category combinators
   * @since 0.3.0
   */
  restore,
  /**
   * @stability stable
   * @category combinators
   * @since 0.3.0
   */
  step,
  /**
   * @stability stable
   * @category predicates
   * @since 0.3.0
   */
  repeatable,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  type StepOptions,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  type ReplayOptions,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  type RestoreOptions,
} from "./internal/execute.ts";

export {
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Ambiguous,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Drifted,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Missing,
} from "./internal/choose.ts";
