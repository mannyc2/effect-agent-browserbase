/**
 * In the page: what one batch of mutations changed, marked for the record as cheaply as it can be.
 *
 * - **An element whose own text changed.** One that holds only text, as most prices and labels do,
 *   is read whole at once, since that text is all it shows, and the batch is undone to say what it
 *   said before; any other is read as it renders. Once followed, a text-only element's changes are
 *   taken as its text's, with no look at the nodes that came and went.
 * - **An element added** is read as it renders; one that moved in the same batch did not arrive.
 *   What came with text its parent gained is part of the parent's change, and what takes a removed
 *   element's place, as a re-rendered price does, takes its history. **An element removed** is
 *   noted only if the record follows it, so a removal it never saw is not told.
 * - **`hidden`, `open`, `aria-hidden`, `class` or `style`** may show or hide an element. The old
 *   value says whether it was hidden before, except for a class, where only the element's state as
 *   the record last saw it can: what it follows, what alerts, status lines, dialogs and popovers
 *   showed when it started, and what an earlier class change showed. A style that neither hid it
 *   nor hides it, such as a transform, shows nothing new.
 * - **The document's title.**
 *
 * See `names.inpage.ts` for what a page-side part may use.
 */
import type { Names } from "../reading/names.inpage.ts";
import type { Shown } from "./fold.inpage.ts";
import type { History } from "./history.inpage.ts";
import type { Sight } from "./sight.inpage.ts";

interface Batch {
  readonly at: number;
  readonly owners: Set<Element>;
  readonly arrived: Set<Node>;
  readonly left: Set<Node>;
}

export const marks = (names: Names, kept: History, seeing: Sight) => {
  const { clean, isElement, isHtml } = names;
  const unwritten = new Set("SCRIPT STYLE NOSCRIPT TEMPLATE TITLE".split(" "));
  const hiding = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])/i;
  // Where removed elements were, which gives their context, and the title as last seen.
  let places = new WeakMap<object, Element>();
  let title = "";

  const words = (text: string | null | undefined): Shown => clean(text, 200) || null;

  const content = (element: Element, at: number, shown: Shown, initial: () => Shown) => {
    const sample = kept.note(element, "content", at, shown, initial);

    if (sample !== undefined) seeing.look(element, sample);
  };

  /** What a text-only element said before this batch: its text with the batch undone. */
  const before = (leaf: Element, records: ReadonlyArray<MutationRecord>): Shown => {
    let nodes: Array<Node> = Array.from(leaf.childNodes);
    const old = new Map<Node, string>();

    for (const record of records.toReversed())
      if (record.type === "characterData") old.set(record.target, record.oldValue ?? "");
      else {
        const added = new Set(Array.from(record.addedNodes));

        nodes = nodes.filter((node) => !added.has(node));
        const next = record.nextSibling === null ? -1 : nodes.indexOf(record.nextSibling);

        nodes.splice(next === -1 ? nodes.length : next, 0, ...Array.from(record.removedNodes));
      }

    return words(nodes.map((node) => old.get(node) ?? node.textContent).join(""));
  };

  const attribute = (
    element: Element,
    { attributeName: name, oldValue: old }: MutationRecord,
    at: number,
  ) => {
    // Whether the old value hid it; a class can say only through the page's style.
    const was =
      name === "hidden"
        ? old !== null
        : name === "aria-hidden"
          ? old === "true"
          : name === "open"
            ? element.tagName === "DIALOG" && old === null
            : name === "style" && hiding.test(old ?? "");

    if (name === "style" && !was && !hiding.test(element.getAttribute("style") ?? "")) return;
    const state = seeing.state(element);

    if (!kept.has(element) && !was && state === undefined && name !== "open")
      return seeing.glance(element);
    content(element, at, undefined, () =>
      was || state === false
        ? null
        : name === "open" && old === null
          ? words(element.querySelector(":scope > summary")?.textContent)
          : words(element.textContent),
    );
  };

  /** What one mutation added to and removed from `target`. */
  const nodes = (change: MutationRecord, target: Element, batch: Batch) => {
    const added = Array.from(change.addedNodes).slice(0, 64);
    const removed = Array.from(change.removedNodes).slice(0, 64);

    const text = [...added, ...removed].some(
      (node) => !isElement(node) && /\S/.test(node.textContent ?? ""),
    );

    kept.lose(batch.at, Math.max(change.addedNodes.length, change.removedNodes.length) - 64);
    if (text) batch.owners.add(target);
    removed.forEach((gone, index) => {
      const node = added[index];

      if (!isElement(gone)) return;
      batch.left.add(gone);
      if (node !== undefined && isElement(node) && kept.rekey(gone, node)) seeing.unwatch(gone);
      else if (kept.has(gone)) {
        places.set(gone, target);
        const sample = kept.note(gone, "content", batch.at, null, () => undefined);

        if (sample !== undefined) sample.seen = seeing.viewed(gone);
        seeing.unwatch(gone);
      }
    });
    for (const node of added)
      if (
        isElement(node) &&
        isHtml(node) &&
        !unwritten.has(node.tagName) &&
        !node.isContentEditable
      )
        if (kept.has(node) || (!text && !batch.left.has(node))) {
          batch.arrived.add(node);
          content(node, batch.at, undefined, () => null);
        }
  };

  /** Whether `element` is inside something this batch added, which tells it with its own words. */
  const inside = (element: Element, arrived: ReadonlySet<Node>): boolean => {
    for (let up = element.parentElement; arrived.size > 0 && up !== null; up = up.parentElement)
      if (arrived.has(up)) return true;

    return false;
  };

  const ownerOf = (change: MutationRecord): Node | null =>
    change.type === "characterData" ? change.target.parentElement : change.target;

  /** Mark what one batch of mutations changed, at `at`. */
  const mark = (records: ReadonlyArray<MutationRecord>, at: number) => {
    const batch: Batch = { at, owners: new Set(), arrived: new Set(), left: new Set() };
    let byOwner: Map<Node | null, Array<MutationRecord>> | undefined;

    for (const change of records) {
      const target = ownerOf(change);

      if (target === null || !isElement(target) || inside(target, batch.arrived)) continue;
      // A text-only element the record follows, or has let go, changes only its text, as a
      // ticking price does, so its nodes need no look: each would cost this world a wrapper.
      const known = kept.has(target) || kept.refuses(target);

      if (change.type !== "attributes")
        if (change.type === "characterData" || (target.childElementCount === 0 && known))
          batch.owners.add(target);
        else nodes(change, target, batch);
      else if (isHtml(target) && target !== document.body && target !== document.documentElement)
        attribute(target, change, at);
    }
    for (const owner of batch.owners) {
      const leaf = owner.childElementCount === 0;

      // What the record let go is counted, with no word of it read.
      if (kept.refuses(owner)) kept.lose(at, 1);
      if (kept.refuses(owner) || !isHtml(owner) || unwritten.has(owner.tagName)) continue;
      // What is typed into an editable region is a field's value, told masked as one.
      if (owner === document.body || owner.isContentEditable) continue;
      if (batch.arrived.has(owner) || inside(owner, batch.arrived)) continue;
      content(owner, at, leaf ? words(owner.textContent) : undefined, () => {
        byOwner ??= Map.groupBy(records, ownerOf);

        return leaf ? before(owner, byOwner.get(owner) ?? []) : undefined;
      });
    }
    if (document.title === title) return;
    const previous = words(title);

    const sample = kept.note(
      document,
      "title",
      at,
      words((title = document.title)),
      () => previous,
    );

    if (sample !== undefined) sample.seen = true;
  };

  return {
    mark,
    /** Where a removed element was, which gives its context. */
    placeOf: (key: object): Element | undefined => places.get(key),
    /** Start afresh, from the document's title now. */
    reset: () => {
      places = new WeakMap();
      title = document.title;
    },
  };
};

export type Marks = ReturnType<typeof marks>;
