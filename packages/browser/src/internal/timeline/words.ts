/**
 * What changed on a page, in words for a model: a change with where it is, and what it is. A moment
 * tells its changes this way, and a tool's receipt the changes its action caused.
 */
import type { Subject, SubjectContext } from "../../BrowserEvent.ts";
import type { Change } from "../../Change.ts";

export const quoted = (value: string | undefined) => JSON.stringify(value ?? "");

/** A subject in words, such as `button "Play"`; one without a name says where it was. */
export const named = (subject: Subject, point: string | undefined) => {
  const kind = subject.role ?? subject.tag;

  if (subject.name !== "") return `${kind} ${JSON.stringify(subject.name)}`;

  return point === undefined ? kind : `${kind} at ${point}`;
};

/** A change's context in words: `row "Ether", column "1h"` or `beside "Price", under "Bitcoin"`. */
export const where = ({ row, column, label, heading }: SubjectContext, grouped = false) => {
  const parts = [
    row === undefined ? "" : `row ${quoted(row)}`,
    column === undefined || grouped ? "" : `column ${quoted(column)}`,
    label === undefined ? "" : `beside ${quoted(label)}`,
    heading === undefined || grouped ? "" : `under ${quoted(heading)}`,
  ].filter((part) => part !== "");

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
};

/** A change in words, such as `"$61,240" became "$62,010" (row "Bitcoin", column "Price")`. */
export const describe = (change: Change, grouped = false): string => {
  const { subject, before, after, count, lowest, highest } = change;
  const context = where(subject.context, grouped);

  const range =
    lowest === undefined || highest === undefined ? "" : `, from ${lowest} to ${highest}`;

  const times = count > 1 ? ` (it changed ${count} times${range})` : "";

  switch (change.kind) {
    case "title":
      return `the title ${before === undefined ? "now reads" : `${quoted(before)} became`} ${quoted(after)}`;
    case "value": {
      const field = named(subject, undefined);

      if (after === "checked" || after === "not checked") return `${field} is now ${after}`;
      if (after === undefined || after === "") return `${field} was cleared`;

      return after === "••••" || before === undefined || before === ""
        ? `${field} was ${after === "••••" ? "edited" : `set to ${quoted(after)}`}`
        : `${field} changed from ${quoted(before)} to ${quoted(after)}`;
    }
    case "appeared":
      return `${quoted(after)} appeared${context}`;
    case "disappeared":
      return `${quoted(before)} disappeared${context}`;
    case "brief":
      return `${quoted(after)} appeared and went away again${context}`;
    case "text":
      return before === undefined
        ? `now reads ${quoted(after)}${context}${times}`
        : `${quoted(before)} became ${quoted(after)}${context}${times}`;
  }
};
