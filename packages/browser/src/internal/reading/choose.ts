/**
 * Choosing the one element a recorded subject names, among those `find` gives for its role and
 * name. Context tells them apart. An element in another row, or under another column, is another
 * subject: a row's words must appear somewhere in the element's context, so a table laid out
 * again as cards still matches. The rest are ranked by how much of the recorded context they
 * repeat, a field read the same counting over words found elsewhere. There is no ordinal, so a
 * tie stays a tie.
 */
import type { Subject, SubjectContext } from "../../BrowserEvent.ts";
import type { Found } from "../../Page.ts";
import { match } from "./match.inpage.ts";

export type Choice =
  | { readonly _tag: "One"; readonly found: Found }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Ambiguous"; readonly count: number }
  | { readonly _tag: "Drifted" };

const { normalize } = match();
const fields = ["row", "column", "label", "heading"] as const;

const same = (one: string, other: string) => normalize(one) === normalize(other);

// Whether a value's words appear, in order and whole, among a text's.
const holds = (text: string, value: string) =>
  ` ${normalize(text)} `.includes(` ${normalize(value)} `);

const said = (context: SubjectContext) =>
  fields.flatMap((field) => {
    const value = context[field];

    return value === undefined ? [] : [value];
  });

export const choose = (subject: Subject, found: ReadonlyArray<Found>): Choice => {
  const recorded = subject.context;
  const { row, column } = recorded;
  // `find` matched the role; a subject without one only matches elements without one.
  const named = found.filter((one) => subject.role !== null || one.subject.role === null);

  if (named.length === 0) return { _tag: "Missing" };

  const kept = named.filter(({ subject: { context } }) => {
    const elsewhere = row !== undefined && !said(context).some((value) => holds(value, row));

    return (
      !elsewhere &&
      (column === undefined || context.column === undefined || same(context.column, column))
    );
  });

  if (kept.length === 0) return { _tag: "Drifted" };

  const score = (context: SubjectContext) =>
    fields.reduce((total, field) => {
      const value = recorded[field];
      const own = context[field];

      if (value === undefined) return total;
      if (own !== undefined && same(own, value)) return total + 2;

      return said(context).some((other) => holds(other, value)) ? total + 1 : total;
    }, 0);

  const scores = kept.map((one) => score(one.subject.context));
  const best = Math.max(...scores);
  const top = kept.filter((_, index) => scores[index] === best);
  const [only] = top;

  return top.length === 1 && only !== undefined
    ? { _tag: "One", found: only }
    : { _tag: "Ambiguous", count: top.length };
};
