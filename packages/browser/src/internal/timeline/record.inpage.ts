/**
 * In the page: the change recorder. It starts at a read of the page's changes, and from then on at
 * the start of each document the page loads, once that document is parsed; it stops in a document
 * nobody has read for two minutes. While it runs, a MutationObserver hands each batch to
 * `marks.inpage.ts`, and an IntersectionObserver judges as the page renders whether what was marked
 * was in view (`sight.inpage.ts`). A field reports its value as it is edited, a secret one only as
 * `••••`, and trusted pointer and key input is kept, for a read to name causes by. Nothing unmarked
 * is read: no walk, no words, no layout. See `names.inpage.ts` for what a page-side part may use.
 */
import type { Names } from "../reading/names.inpage.ts";
import type { Texts } from "../reading/text.inpage.ts";
import type { History } from "./history.inpage.ts";
import type { Marks } from "./marks.inpage.ts";
import type { Sight } from "./sight.inpage.ts";

export const record = (
  names: Names,
  texts: Texts,
  kept: History,
  seeing: Sight,
  marking: Marks,
) => {
  const { isElement, isInput } = names;
  const epoch = () => performance.timeOrigin + performance.now();

  const declared =
    "[role=alert],[role=status],[role=log],[role=dialog],[role=alertdialog],[aria-live],dialog,[popover]";

  let running = false;
  let lastRead = 0;
  // What fields held as they took focus, and the latest trusted input, newest last.
  let focused = new WeakMap<Element, string>();
  const inputs: Array<{ readonly at: number; readonly target: Element }> = [];

  const targetOf = (event: Event): Element | undefined => {
    const target = event.composedPath()[0];

    return target instanceof Node && isElement(target) ? target : undefined;
  };

  /** A field's value as the record keeps it: a secret one's as `••••`, a box's checked or not. */
  const valueOf = (field: Element): string | undefined =>
    isInput(field) && (field.type === "checkbox" || field.type === "radio")
      ? field.checked
        ? "checked"
        : "not checked"
      : texts.shown(field, true);

  const onFocus = (event: Event) => {
    const field = targetOf(event);
    const value = field === undefined ? undefined : valueOf(field);

    if (field !== undefined && value !== undefined) focused.set(field, value);
  };

  const onValue = (event: Event) => {
    const field = targetOf(event);
    const value = field === undefined ? undefined : valueOf(field);

    if (field === undefined || value === undefined) return;
    const sample = kept.note(field, "value", epoch(), value, () => focused.get(field) ?? null);

    if (sample !== undefined) seeing.look(field, sample);
  };

  const onInput = (event: Event) => {
    const target = targetOf(event);

    if (!event.isTrusted || target === undefined) return;
    inputs.push({ at: performance.timeOrigin + event.timeStamp, target });
    if (inputs.length > 8) inputs.shift();
  };

  const listeners = [
    ["focusin", onFocus],
    ["input", onValue],
    ["change", onValue],
    ["pointerdown", onInput],
    ["keydown", onInput],
  ] as const;

  const options = { capture: true, passive: true };

  const stop = () => {
    running = false;
    observer.disconnect();
    for (const [type, listener] of listeners) document.removeEventListener(type, listener, options);
    seeing.clear();
    kept.clear();
    kept.forgotten();
    inputs.length = 0;
    focused = new WeakMap();
  };

  const observer = new MutationObserver((records) => {
    const at = epoch();

    if (at - lastRead > 120_000) stop();
    else marking.mark(records, at);
  });

  const begin = () => {
    if (!running || kept.begun()) return;
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributeFilter: ["hidden", "open", "aria-hidden", "class", "style"],
      attributeOldValue: true,
    });
    for (const [type, listener] of listeners) document.addEventListener(type, listener, options);
    marking.reset();
    for (const element of Array.from(document.querySelectorAll(declared)).slice(0, 64))
      seeing.glance(element, true);
    kept.begin(epoch());
  };

  return {
    /** Record from now, once the document is parsed; each read keeps the record going. */
    start: () => {
      lastRead = epoch();
      if (running) return;
      running = true;
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", begin, { once: true });
      else begin();
    },
    inputs: (): ReadonlyArray<{ readonly at: number; readonly target: Element }> => inputs,
  };
};

export type Recorder = ReturnType<typeof record>;
