import { Effect, Layer } from "effect";
import { BrowserActions } from "effect-agent/browser-use";
import type { RunSchedulingHook } from "effect-agent/run-options";
import {
  checkPage,
  type BrowserSession,
  type ElementAdmission,
  type Frame,
  type Page,
} from "effect-browser/browser";
import type { FillFormOptions } from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";

import { makeActions } from "./internal/BrowserActions.ts";
import { direct } from "./internal/tools/Handlers.ts";
import { bindingOf, type ToolHost } from "./internal/tools/Host.ts";
import {
  configuration,
  type HandlerOptions,
  knownKeys,
  type Observe,
  resolveOptions,
} from "./internal/tools/Options.ts";

/**
 * How `observe` reads the page. Effect Agent's browser Tools have no scroll or search, so a
 * reading covers the whole document by default and issues as many controls as the browser allows.
 */
export interface ReadingOptions {
  /** Text a model is shown from one reading, 8 KiB by default (1–131072 bytes). */
  readonly maxTextBytes?: number;
  /** Controls read at once, 64 by default (0–64); each option of a select is one of them. */
  readonly maxControls?: number;
  /** `document` by default; `viewport` reads only what is on screen and reachable. */
  readonly observationScope?: "document" | "viewport";
}

/** The reading, and the exact-node policy and execution the Tools' `HandlerOptions` take. */
export interface Options extends ReadingOptions {
  /** Synchronous, on fresh exact-node facts under the owner's permit. Never a Tool parameter. */
  readonly policy?: ElementAdmission;
  /** Host-only single-step timing and queue configuration; see `HandlerOptions.execution`. */
  readonly execution?: HandlerOptions["execution"];
  /** How a batch proceeds as a form: verification before its click and settling between steps. */
  readonly form?: FillFormOptions;
  /** Replaces how the page is read; see the Tools' `Observe`. */
  readonly observe?: Observe;
}

const readingKeys = {
  maxTextBytes: true,
  maxControls: true,
  observationScope: true,
} as const satisfies Record<keyof ReadingOptions, true>;

const optionKeys = {
  ...readingKeys,
  policy: true,
  execution: true,
  form: true,
  observe: true,
} as const satisfies Record<keyof Options, true>;

/** Defaults only for omitted keys: an explicit null or other invalid value is still refused. */
const reading = (options: ReadingOptions) => ({
  ...options,
  maxControls: options.maxControls === undefined ? 64 : options.maxControls,
  observationScope: options.observationScope === undefined ? "document" : options.observationScope,
});

/**
 * Effect Agent's `BrowserActions` over one issued Page, or a Frame one of its Pages issued, of a
 * borrowed session, with caller-managed sequencing: provide it to `BrowserUse.make(...).layer()`
 * from `effect-agent/browser-use`. The target and options are checked when the Layer is built.
 *
 * `observe` issues refs that name their observation; only the latest one's refs resolve, and
 * every action retires it. `act` validates every action first, then sends a single action, or a
 * batch of fills and selects with one optional final click as one form. It reports what the
 * browser acknowledged, stops at the first failure, reads the page again and never replays.
 */
export const layer = <E>(
  browser: BrowserSession<E>,
  page: Page | Frame,
  options: Options = {},
): Layer.Layer<BrowserActions, BrowserError> =>
  Layer.effect(
    BrowserActions,
    Effect.gen(function* () {
      yield* checkPage(browser, page);
      yield* knownKeys("", options, optionKeys);

      return yield* makeActions(page, yield* resolveOptions(reading(options)), direct);
    }),
  );

/**
 * The same `BrowserActions` through a host `Tools.makeHost` issued: its lane, receipts, failure
 * record and `onInput` callback, its policy, execution and form options and its bound Page. Run
 * the program through `host.run` for its supervision. Records name the Tool `observe` or `act`
 * and carry no tool-call ID. A copy or wrapper of the host is refused when the Layer is built.
 */
export const fromHost = <OwnerError, CallbackError>(
  host: ToolHost<OwnerError, CallbackError>,
  options: ReadingOptions = {},
): Layer.Layer<BrowserActions, BrowserError> =>
  Layer.effect(
    BrowserActions,
    Effect.gen(function* () {
      const binding = bindingOf(host);

      if (binding === undefined) return yield* configuration("host");
      yield* knownKeys("", options, readingKeys);
      const read = yield* resolveOptions(reading(options));

      return yield* makeActions(
        binding.page,
        {
          ...binding.options,
          maxTextBytes: read.maxTextBytes,
          maxControls: read.maxControls,
          observationScope: read.observationScope,
        },
        binding.hooks,
      );
    }),
  );

/**
 * Effect Agent's `observe` and `act` as sequential barriers, added to whatever the hook already
 * schedules, so the engine runs each one alone and in the order the model declared it. Install
 * it as `RunToolScheduling`, or pass it as `RunOptions.scheduling`; within `host.run`, the Tools'
 * own `sequentialScheduling` composes with it.
 */
export const sequentialScheduling = (hook: RunSchedulingHook = {}): RunSchedulingHook => ({
  ...hook,
  toolRequiresSequential: (name) =>
    name === "observe" || name === "act" || hook.toolRequiresSequential?.(name) === true,
});
