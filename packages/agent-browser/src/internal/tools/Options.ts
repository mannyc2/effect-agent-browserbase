import { Effect, Schema } from "effect";
import type { AnySession, ElementAdmission } from "effect-browser/browser";
import { FillFormOptions, type Observation } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";

import { ResultMaxBytes } from "./Model.ts";

/** One reading the Tools ask for: the host's bounds and what the model chose. */
export interface InspectionRequest {
  readonly scope: "document" | "viewport";
  readonly match?: string;
  /** Text read from the page: what a model is shown at once, plus what it may read on. */
  readonly maxTextBytes: number;
  readonly maxControls: number;
}

/**
 * How the Tools read the page, for `browser_inspect` and for the observation after an action.
 * The default is `browser.observe(request)`. A replacement may wait, retry or narrow first, but
 * must return a reading the same browser issued, because its references are what later actions
 * name. A failure is reported like any other failed reading.
 */
export type Observe = (
  request: InspectionRequest,
  browser: AnySession,
) => Effect.Effect<Observation, BrowserError>;

export interface HandlerOptions {
  /** Text a model is shown from one reading, 8 KiB by default (1–131072 bytes). */
  readonly maxTextBytes?: number;
  /** Controls in one reading, 16 by default (0–64). */
  readonly maxControls?: number;
  /** The scope a reading uses when the model does not choose one, `viewport` by default. */
  readonly observationScope?: "document" | "viewport";
  /**
   * The bound on each encoded Tool result, 48 KiB by default (16 KiB–1 MiB). A reading that does
   * not fit loses text first and then trailing controls, never the references it keeps.
   */
  readonly resultMaxBytes?: number;
  /**
   * Text read from the page per reading, so `browser_read_more` can continue past what the model
   * was shown: 32 KiB by default, at least `maxTextBytes` and at most 131072. A browser policy
   * that returns less reads `maxTextBytes` instead.
   */
  readonly continuationBytes?: number;
  /** Synchronous, on fresh exact-node facts under the owner's permit. Never a Tool parameter. */
  readonly admission?: ElementAdmission;
  /** How `browser_fill_form` proceeds: verification before submit and settling between steps. */
  readonly form?: FillFormOptions;
  /** Replaces how the Tools read the page; see `Observe`. */
  readonly observe?: Observe;
}

/** Every option decided, once, before any Tool runs. */
export interface ResolvedOptions {
  readonly maxTextBytes: number;
  readonly maxControls: number;
  readonly observationScope: "document" | "viewport";
  readonly resultMaxBytes: number;
  readonly continuationBytes: number;
  readonly admission: ElementAdmission | undefined;
  readonly form: FillFormOptions;
  readonly observe: Observe;
}

export const configuration = (path: string) =>
  BrowserError.make({
    operation: "configure",
    reason: Reasons.Configuration.make({ path }),
    outcome: "undispatched",
  });

/** Omission takes the default; anything else, including an explicit null, must be valid. */
export const option = <A>(
  path: string,
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown,
  fallback: A,
): Effect.Effect<A, BrowserError> =>
  value === undefined
    ? Effect.succeed(fallback)
    : Schema.decodeEffect(schema)(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => configuration(path)),
      );

const TextBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 131072 }));

const defaultObserve: Observe = (request, browser) => browser.observe(request);

/** Checked when a host or handler Layer is built, so an invalid bound never reaches the model. */
export const resolveOptions = Effect.fnUntraced(function* (options: HandlerOptions) {
  const maxTextBytes = yield* option("maxTextBytes", TextBytes, options.maxTextBytes, 8192);

  const maxControls = yield* option(
    "maxControls",
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 })),
    options.maxControls,
    16,
  );

  const observationScope = yield* option(
    "observationScope",
    Schema.Literals(["document", "viewport"]),
    options.observationScope,
    "viewport",
  );

  const resultMaxBytes = yield* option(
    "resultMaxBytes",
    ResultMaxBytes,
    options.resultMaxBytes,
    48 * 1024,
  );

  const continuationBytes = yield* option(
    "continuationBytes",
    TextBytes.check(Schema.isGreaterThanOrEqualTo(maxTextBytes)),
    options.continuationBytes,
    Math.max(maxTextBytes, 32 * 1024),
  );

  const form = yield* option("form", FillFormOptions, options.form, {});

  if (options.admission !== undefined && typeof options.admission?.admit !== "function")
    return yield* configuration("admission");
  if (options.observe !== undefined && typeof options.observe !== "function")
    return yield* configuration("observe");

  return {
    maxTextBytes,
    maxControls,
    observationScope,
    resultMaxBytes,
    continuationBytes,
    // A host's later edits to its own object never change an admitted policy.
    admission: options.admission === undefined ? undefined : { admit: options.admission.admit },
    form,
    observe: options.observe ?? defaultObserve,
  } satisfies ResolvedOptions;
});
