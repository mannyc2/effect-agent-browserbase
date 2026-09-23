import { Result, Schema } from "effect";
import { Observation, ObservedControl } from "effect-browser/browser-data";

import type { ReadMoreResult } from "./Model.ts";

const encoder = new TextEncoder();

/** What Effect Agent measures against `toolResultBounds`: the UTF-8 JSON of an encoded result. */
export const measure = <A>(schema: Schema.Codec<A, unknown, never, never>) => {
  const encode = Schema.encodeResult(schema);

  return (value: A): number => {
    const encoded = encode(value);

    // Only a value that bypassed its schema's validation fails to encode.
    if (Result.isFailure(encoded)) throw encoded.failure;

    return encoder.encode(JSON.stringify(encoded.success)).length;
  };
};

/** The longest prefix within a UTF-8 byte bound; a code point is never split. */
export const prefixWithin = (text: string, maxBytes: number): string => {
  // One UTF-16 code unit never needs more than three UTF-8 bytes.
  if (text.length * 3 <= maxBytes) return text;
  const { read } = encoder.encodeInto(text, new Uint8Array(maxBytes));

  return text.slice(0, read);
};

/** A cut never leaves half of a surrogate pair behind. */
const boundary = (text: string, length: number): number => {
  if (length <= 0 || length >= text.length) return Math.max(0, Math.min(length, text.length));
  const unit = text.charCodeAt(length - 1);

  return unit >= 0xd800 && unit <= 0xdbff ? length - 1 : length;
};

/** The largest `n` in `[0, high]` for which `fits(n)` holds, given `fits(0)`; `fits` is monotone. */
const largest = (high: number, fits: (n: number) => boolean): number => {
  let low = 0;
  let top = high;

  while (low < top) {
    const middle = Math.ceil((low + top) / 2);

    if (fits(middle)) low = middle;
    else top = middle - 1;
  }

  return low;
};

/**
 * The first `count` controls. An option whose select was left out goes too, and a select that
 * lost some of its options says so, exactly as a reading that ran out of controls does.
 */
const firstControls = (controls: ReadonlyArray<ObservedControl>, count: number) => {
  const kept = controls.slice(0, count);

  const selects = new Set(
    kept.filter((control) => control.kind === "select").map((c) => c.elementId),
  );

  const cut = new Set(
    controls
      .slice(count)
      .flatMap((control) =>
        control.selectElementId === undefined ? [] : [control.selectElementId],
      ),
  );

  return kept
    .filter(
      (control) => control.selectElementId === undefined || selects.has(control.selectElementId),
    )
    .map((control) =>
      cut.has(control.elementId) && control.optionsTruncated !== true
        ? ObservedControl.make({ ...control, optionsTruncated: true })
        : control,
    );
};

export interface Fitted {
  readonly observation: Observation;
  /** How much of the reading's text, in UTF-16 code units, the model was shown. */
  readonly shown: number;
}

/**
 * The reading a model is shown: at most `maxTextBytes` of text, then as much of that as the
 * result bound allows, then only as many leading controls as fit. What a model is not shown is
 * marked truncated, never silently dropped. `size` measures the whole result that carries it.
 * Undefined when not even the reading's fixed fields fit.
 */
export const fitObservation = (
  observation: Observation,
  maxTextBytes: number,
  maxBytes: number,
  size: (candidate: Observation) => number,
): Fitted | undefined => {
  const text = prefixWithin(observation.text, maxTextBytes);

  const shape = (length: number, count = observation.controls.length) =>
    Observation.make({
      ...observation,
      text: text.slice(0, length),
      textTruncated: observation.textTruncated || length < observation.text.length,
      controls:
        count === observation.controls.length
          ? observation.controls
          : firstControls(observation.controls, count),
      controlsTruncated: observation.controlsTruncated || count < observation.controls.length,
    });

  const whole = shape(text.length);

  if (size(whole) <= maxBytes) return { observation: whole, shown: text.length };
  if (size(shape(0)) <= maxBytes) {
    const length = boundary(
      text,
      largest(text.length, (n) => size(shape(boundary(text, n))) <= maxBytes),
    );

    return { observation: shape(length), shown: length };
  }
  if (size(shape(0, 0)) > maxBytes) return undefined;
  const count = largest(observation.controls.length, (n) => size(shape(0, n)) <= maxBytes);

  return { observation: shape(0, count), shown: 0 };
};

/**
 * The rest of the latest reading's text, for `browser_read_more`. Only the latest reading is
 * kept: every later one replaces it, and its text is data the model was already entitled to.
 */
export interface Continuation {
  readonly remember: (observation: Observation, shown: number) => void;
  readonly next: (
    observationId: string,
    maxTextBytes: number,
    maxBytes: number,
    size: (result: ReadMoreResult) => number,
  ) => ReadMoreResult | undefined;
}

export const makeContinuation = (): Continuation => {
  let latest:
    | {
        readonly observationId: string;
        readonly text: string;
        readonly truncated: boolean;
        cursor: number;
      }
    | undefined;

  return {
    remember: (observation, shown) => {
      latest = {
        observationId: observation.observationId,
        text: observation.text,
        truncated: observation.textTruncated,
        cursor: shown,
      };
    },
    next: (observationId, maxTextBytes, maxBytes, size) => {
      const reading = latest;

      if (reading === undefined || reading.observationId !== observationId) return undefined;
      const rest = prefixWithin(reading.text.slice(reading.cursor), maxTextBytes);

      const part = (length: number): ReadMoreResult => ({
        observationId,
        text: rest.slice(0, length),
        remaining: reading.cursor + length < reading.text.length,
        textTruncated: reading.truncated,
      });

      const length = boundary(
        rest,
        size(part(rest.length)) <= maxBytes
          ? rest.length
          : largest(rest.length, (n) => size(part(boundary(rest, n))) <= maxBytes),
      );

      const result = part(length);

      reading.cursor += length;

      return result;
    },
  };
};

const continuations = new WeakMap<object, Continuation>();

/**
 * One continuation per borrowed session, shared by every handler Layer over it, so reading on
 * finds the latest reading whichever Layer made it.
 */
export const continuationFor = (browser: object): Continuation => {
  let continuation = continuations.get(browser);

  if (continuation === undefined) {
    continuation = makeContinuation();
    continuations.set(browser, continuation);
  }

  return continuation;
};
