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
 * covers that point. `take` and `replay` return receipts; failure preserves a stopping point and
 * earlier receipts. Unknown consequential input is never resent. Only a positive durable read-back
 * can reconcile it; restoration follows the same rule. The consumer journals begun steps before
 * calling, treating interruption or a missing receipt as unknown. Version 3 carries canonical typed
 * Actions. Prior string-action plans and unknown versions do not decode.
 *
 * @since 0.3.0
 */
export { Expected, Step, Plan, Receipt, Stopped, Uncertain, ReplayError } from "./data.ts";
export { fromEvents } from "./record.ts";
export { locate } from "./targets.ts";

export {
  replay,
  restore,
  take,
  repeatable,
  type TakeOptions,
  type ReplayOptions,
} from "./execute.ts";

export { Ambiguous, Drifted, Missing } from "./choose.ts";
