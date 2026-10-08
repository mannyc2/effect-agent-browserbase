/**
 * Choosing the one element a recorded subject names, among those `find` gives for its role and
 * name. Context tells them apart, and an element that does not repeat every part of the recorded
 * context is another subject, so a sole element left once its own has gone, such as Alice's
 * "Remove" after Bob has left, drifts rather than stands in:
 *
 * - a row is read whole: a row named "Wrapped BTC" is not the row "BTC". Laid out again without
 *   rows, as cards, one of the element's fields must start with the row's words;
 * - a column counts where the element is under one;
 * - a label or heading must read the same, or its words appear, whole and in order, in one of the
 *   element's fields, as `near` reads them.
 *
 * The rest are ranked by how much of the recorded context they read the same. There is no
 * ordinal, so a tie stays a tie.
 */
import { Effect, Schema } from "effect";

import type { Subject, SubjectContext } from "../../BrowserEvent.ts";
import type { Found } from "../../Page.ts";
import { match } from "./match.inpage.ts";

/** Nothing on the page has the step's role and name. */
export class Missing extends Schema.TaggedError<Missing>()("Missing", {}) {
  override get message() {
    return "nothing on the page has the recorded role and name";
  }
}

/** Several elements match the step's subject equally well, and nothing tells them apart. */
export class Ambiguous extends Schema.TaggedError<Ambiguous>()("Ambiguous", {
  count: Schema.Int,
}) {
  override get message() {
    return `${this.count} elements match the recorded subject equally well`;
  }
}

/** The page is not where the recording was: another site, or no element with its context. */
export class Drifted extends Schema.TaggedError<Drifted>()("Drifted", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const { holds, normalize } = match();
const fields = ["row", "column", "label", "heading"] as const;

const said = (context: SubjectContext) =>
  Object.values(context).filter((value) => typeof value === "string");

/** How an element repeats one recorded field: 2 read the same, 1 found as words, 0 not at all. */
const repeats = (field: (typeof fields)[number], value: string, context: SubjectContext) => {
  const own = context[field];

  if (own !== undefined && normalize(own) === normalize(value)) return 2;
  if (field === "column") return own === undefined ? 1 : 0;
  if (field === "row")
    return own === undefined &&
      said(context).some((other) => `${normalize(other)} `.startsWith(`${normalize(value)} `))
      ? 1
      : 0;

  return said(context).some((other) => holds(other, value)) ? 1 : 0;
};

export const choose = (
  subject: Subject,
  found: ReadonlyArray<Found>,
): Effect.Effect<Found, Missing | Ambiguous | Drifted> => {
  // `find` matched the role; a subject without one only matches elements without one.
  const named = found.filter((one) => subject.role !== null || one.subject.role === null);

  const kept = named.flatMap((one) => {
    let score = 0;

    for (const field of fields) {
      const value = subject.context[field];
      const repeated = value === undefined ? 0 : repeats(field, value, one.subject.context);

      if (value !== undefined && repeated === 0) return [];
      score += repeated;
    }

    return [{ one, score }];
  });

  const best = Math.max(...kept.map(({ score }) => score));
  const top = kept.filter(({ score }) => score === best);
  const [only] = top;

  if (named.length === 0) return Effect.fail(new Missing());
  if (kept.length === 0)
    return Effect.fail(new Drifted({ detail: "no element named so repeats the recorded context" }));

  return top.length === 1 && only !== undefined
    ? Effect.succeed(only.one)
    : Effect.fail(new Ambiguous({ count: top.length }));
};
