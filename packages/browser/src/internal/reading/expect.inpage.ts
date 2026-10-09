/**
 * In the page: the wait an expectation takes on what `find` matches, and the mark that stands for
 * what the matches show. See `names.inpage.ts` for what a page-side part may use.
 */
import type { FindRequest } from "./match.inpage.ts";
import type { Names } from "./names.inpage.ts";
import type { Subjects } from "./subjects.inpage.ts";

/**
 * What an expectation waits for of a query's matches: some, none, or a mark other than one `until`
 * gave before.
 */
export type Want = "some" | "none" | { readonly other: string };

export const expectations = (names: Names, subjected: Subjects) => {
  const { isInput, isSelect, isTextArea, roleOf, textOf } = names;
  const { elementsOf, stateOf } = subjected;

  // What matched elements show, their text, values and states but focus, as a mark that carries
  // none of it: a count and FNV-1a over each in turn.
  const markOf = (elements: ReadonlyArray<Element>) => {
    let hash = 0x811c9dc5;

    for (const element of elements) {
      const { focused: _focused, ...state } = stateOf(element, roleOf(element));

      const value =
        isInput(element) || isSelect(element) || isTextArea(element) ? element.value : "";

      const shown = `${textOf(element)}\u0000${value}\u0000${JSON.stringify(state)}\u0001`;

      for (let index = 0; index < shown.length; index++)
        hash = Math.imul(hash ^ shown.charCodeAt(index), 0x01000193);
    }

    return `${elements.length}:${(hash >>> 0).toString(16)}`;
  };

  /**
   * What `find` matches, looked at every 100 ms until `want` holds of it or `millis` have passed,
   * with its mark then. It gives no refs.
   */
  const until = async (request: FindRequest, want: Want, millis: number) => {
    const deadline = performance.now() + millis;

    for (;;) {
      const elements = elementsOf(request);
      const mark = markOf(elements);

      const met =
        want === "some"
          ? elements.length > 0
          : want === "none"
            ? elements.length === 0
            : mark !== want.other;

      const left = deadline - performance.now();

      if (met || left <= 0) return { met, mark };
      const { promise, resolve } = Promise.withResolvers<void>();

      setTimeout(resolve, Math.min(100, left));
      await promise;
    }
  };

  return { until };
};

export type Expectations = ReturnType<typeof expectations>;
