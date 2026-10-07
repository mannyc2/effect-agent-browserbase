/**
 * In the page: the rules `find` matches by. It touches no DOM, so it also runs outside a page.
 *
 * - A role matches when it is the same token, ignoring case and the space around it.
 * - A name given as a string matches when the two read the same once their spaces are collapsed,
 *   their case folded and their characters given one Unicode form; a pattern matches when it
 *   finds itself in the name.
 * - Text matches when it appears, read the same way, in the element's text.
 * - `near` matches when its words appear, whole and in order, in any of the element's context:
 *   its row, column, label or heading. Replay chooses among candidates by the same rule.
 */
import type { Context } from "./context.inpage.ts";

/** A string, or a pattern sent to the page as its source and flags. */
export type Wanted = string | { readonly source: string; readonly flags: string };

export interface FindRequest {
  readonly role: string | null;
  readonly name: Wanted | null;
  readonly text: Wanted | null;
  readonly near: string | null;
  readonly at: { readonly x: number; readonly y: number } | null;
  readonly scope: "viewport" | "document";
  readonly firstRef: number;
}

/** What a query is matched against, read only when a rule needs it. */
export interface Candidate {
  readonly role: string | null;
  readonly name: () => string;
  readonly text: () => string;
  readonly context: () => Context;
}

export const match = () => {
  /**
   * How names, text and context compare: one Unicode form, without invisible format characters,
   * spaces collapsed, and case folded upper first, so that "ß" and "SS" read the same.
   */
  const normalize = (value: string): string =>
    value
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase()
      .toLowerCase();

  /** A string that reads the same, or, unless `whole`, appears within; or a pattern found within. */
  const rule = (wanted: Wanted, whole: boolean) => {
    if (typeof wanted !== "string") {
      // `g` and `y` keep a position from one test to the next, so one pattern would answer
      // differently for each element. A pattern is tried on the text as the page shows it.
      const found = new RegExp(wanted.source, wanted.flags.replace(/[gy]/g, ""));

      return (value: string) => found.test(value.replace(/\s+/g, " ").trim());
    }
    const target = normalize(wanted);

    return whole
      ? (value: string) => normalize(value) === target
      : (value: string) => normalize(value).includes(target);
  };

  /** Whether a value's words appear, whole and in order, among a text's: "BTC" not in "WBTC". */
  const holds = (text: string, value: string) =>
    ` ${normalize(text)} `.includes(` ${normalize(value)} `);

  /** Whether a candidate meets every rule a query gives; a rule left out always holds. */
  const compile = (request: Pick<FindRequest, "role" | "name" | "text" | "near">) => {
    const role = request.role === null ? null : normalize(request.role);
    const name = request.name === null ? null : rule(request.name, true);
    const text = request.text === null ? null : rule(request.text, false);
    const { near } = request;

    return (candidate: Candidate): boolean => {
      if (role !== null && normalize(candidate.role ?? "") !== role) return false;
      if (text !== null && !text(candidate.text())) return false;
      if (name !== null && !name(candidate.name())) return false;
      if (near === null) return true;
      const { row, column, label, heading } = candidate.context();

      return [row, column, label, heading].some(
        (value) => value !== undefined && holds(value, near),
      );
    };
  };

  return { compile, holds, normalize };
};

export type Match = ReturnType<typeof match>;
