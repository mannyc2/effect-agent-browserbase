/**
 * Choosing the one element a recorded subject names, among those `find` gives for its role and
 * name. Context tells them apart, word for word as `near` reads it. An element in another row,
 * or under another column, is another subject: a row's words must appear somewhere in the
 * element's context, so a table laid out again as cards still matches. The rest are ranked by how
 * much of the recorded context they repeat, a field read the same counting over words found
 * elsewhere. There is no ordinal, so a tie stays a tie.
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

/** The page is not where the recording was: another site, or the subject in another row. */
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

export const choose = (
  subject: Subject,
  found: ReadonlyArray<Found>,
): Effect.Effect<Found, Missing | Ambiguous | Drifted> => {
  const recorded = subject.context;
  const { row, column } = recorded;
  // `find` matched the role; a subject without one only matches elements without one.
  const named = found.filter((one) => subject.role !== null || one.subject.role === null);

  const kept = named.filter(
    ({ subject: { context } }) =>
      (row === undefined || said(context).some((value) => holds(value, row))) &&
      (column === undefined ||
        context.column === undefined ||
        normalize(context.column) === normalize(column)),
  );

  const score = (context: SubjectContext) =>
    fields.reduce((total, field) => {
      const value = recorded[field];
      const own = context[field];

      if (value === undefined) return total;
      if (own !== undefined && normalize(own) === normalize(value)) return total + 2;

      return said(context).some((other) => holds(other, value)) ? total + 1 : total;
    }, 0);

  const scores = kept.map((one) => score(one.subject.context));
  const top = kept.filter((_, index) => scores[index] === Math.max(...scores));
  const [only] = top;

  if (named.length === 0) return Effect.fail(new Missing());
  if (kept.length === 0)
    return Effect.fail(new Drifted({ detail: "the subject is in another row or column" }));

  return top.length === 1 && only !== undefined
    ? Effect.succeed(only)
    : Effect.fail(new Ambiguous({ count: top.length }));
};
