/**
 * In the page: whether what the recorder marked was in view, and what it showed, judged as the page
 * renders it. An IntersectionObserver watches each element the record follows: it reports as the
 * page renders, forces no layout, and leaves a removed element the state it last reported. What
 * changed counts as seen when it was in the viewport and its style showed it; what went counts as
 * seen when it was in view before it went. Words that need the page's layout are read on render
 * too, as `text` reads an element, by the walk's one rule for what shows and with fields masked.
 * An element whose state alone the record wants, as for a class change on something it does not
 * follow, is looked at once. See `names.inpage.ts` for what a page-side part may use.
 */
import type { Names } from "../reading/names.inpage.ts";
import type { Texts } from "../reading/text.inpage.ts";
import type { Walk } from "../reading/walk.inpage.ts";
import type { Sample, Shown } from "./fold.inpage.ts";
import type { History } from "./history.inpage.ts";

export const sight = (names: Names, walked: Walk, texts: Texts, kept: History) => {
  const { clean } = names;
  const { visible } = walked;
  // Whether each watched element was in view as the page last rendered it, and whether the style
  // of one looked at once showed it.
  let viewed = new WeakMap<Element, boolean>();
  let watching = new WeakSet<Element>();
  let states = new WeakMap<Element, boolean>();
  const waiting = new Map<Element, Array<Sample>>();

  /** What an element shows: its words, if its style shows it. */
  const shownBy = (element: Element): Shown =>
    element.isConnected && visible(element)
      ? clean(texts.lines(element, false), 200) || null
      : null;

  /** Settle what waited on an element; its words are read once, if one of them needs them. */
  const judge = (element: Element, pending: ReadonlyArray<Sample>, seen: boolean, was: boolean) => {
    const shown = pending.some((sample) => sample.shown === undefined)
      ? shownBy(element)
      : undefined;

    for (const sample of pending) {
      const now = sample.shown === undefined ? shown : sample.shown;

      kept.settle(element, sample, now, now === null ? was : seen);
    }
  };

  const observer = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      const was = viewed.get(target) ?? false;
      const seen = isIntersecting && visible(target);
      const pending = waiting.get(target);

      viewed.set(target, seen);
      waiting.delete(target);
      if (pending !== undefined) judge(target, pending, seen, was);
      if (!kept.has(target)) {
        states.set(target, visible(target));
        unwatch(target);
      }
    }
  });

  /** Watch an element, asking for a fresh report even if it is watched already. */
  const watch = (element: Element) => {
    watching.add(element);
    observer.unobserve(element);
    observer.observe(element);
  };

  const unwatch = (element: Element) => {
    watching.delete(element);
    observer.unobserve(element);
  };

  return {
    /** Judge a sample at once if what it shows and whether it is in view are known, else on render. */
    look: (element: Element, sample: Sample) => {
      const view = viewed.get(element);

      if (sample.shown !== undefined && view !== undefined && watching.has(element)) {
        sample.seen = view;

        return;
      }
      waiting.set(element, [...(waiting.get(element) ?? []), sample]);
      watch(element);
    },
    /**
     * Look at an element once, for its state when it next changes: as it renders, or `now`, by its
     * style, as for the few the record looks at as it starts.
     */
    glance: (element: Element, now = false) => {
      if (now) states.set(element, visible(element));
      if (!watching.has(element)) watch(element);
    },
    /** Whether the style of an element looked at once showed it, if it was. */
    state: (element: Element): boolean | undefined => states.get(element),
    /** Whether a watched element was in view as the page last rendered it. */
    viewed: (element: Element): boolean => viewed.get(element) ?? false,
    unwatch,
    /** Judge now what the page has not rendered since it changed, as a hidden tab never does. */
    settle: () => {
      for (const [element, pending] of waiting) {
        const seen =
          element.isConnected && walked.inView(element.getBoundingClientRect()) && visible(element);

        judge(element, pending, seen, viewed.get(element) ?? false);
      }
      waiting.clear();
      for (const key of kept.forgotten()) if (key instanceof Element) unwatch(key);
    },
    clear: () => {
      observer.disconnect();
      waiting.clear();
      viewed = new WeakMap();
      watching = new WeakSet();
      states = new WeakMap();
    },
  };
};

export type Sight = ReturnType<typeof sight>;
