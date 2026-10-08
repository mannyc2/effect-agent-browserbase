/**
 * In the page: an element's context, the words around it that say which one it is:
 *
 * - in a table, its row, named by the row's header or else its first cell with letters, so a rank
 *   or a price never names it, and its column, named by the header over it, so a value is never
 *   read under the wrong header;
 * - elsewhere, the words just before it in its row, item, group or block;
 * - the heading above it, unless it is pinned to the viewport, where the markup says nothing.
 *
 * See `names.inpage.ts` for what a page-side part may use.
 */
import type { SubjectContext } from "../../BrowserEvent.ts";
import type { Names } from "./names.inpage.ts";

/** What one read has learnt of the page: each table's header row and each tree's headings. */
export interface Known {
  readonly headers: Map<Element, Element | null>;
  readonly headings: Map<Node, ReadonlyArray<Element>>;
}

export const context = (names: Names) => {
  const { clean, isButton, isDocument, isHtml, isInput, isRoot } = names;
  const { isSelect, isTextArea, roleOf, textOf } = names;

  const known = (): Known => ({ headers: new Map(), headings: new Map() });

  const shown = (element: Element): boolean =>
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  // Text in these says what a control is called, not what the page says around it.
  const unspoken =
    "button,select,textarea,option,script,style,noscript,template,[role=button],[role=menuitem],[role=option],[role=tab],[role=switch],[role=checkbox],[role=radio],[aria-hidden=true]";

  // Containers whose text usually describes the controls in them: a row, an item, a group or a form.
  const groups =
    "tr,li,article,fieldset,form,section,dialog,[role=row],[role=listitem],[role=group],[role=region],[role=dialog],[role=alertdialog]";

  /** The visible text just before (or after) a target within `scope`, nearest kept, ≤120 characters. */
  const textBeside = (target: Element, scope: Node, backwards: boolean): string => {
    const walker = target.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);

    const labels =
      isInput(target) || isTextArea(target) || isSelect(target) || isButton(target)
        ? Array.from(target.labels ?? [])
        : [];

    let text = "";

    walker.currentNode = target;
    for (let steps = 0; steps < 400 && text.replace(/\s+/g, "").length < 120; steps++) {
      const node = backwards ? walker.previousNode() : walker.nextNode();

      if (node === null) break;
      const parent = node.parentElement;

      if (
        parent === null ||
        target.contains(parent) ||
        parent.closest(unspoken) !== null ||
        (isHtml(parent) && parent.isContentEditable) ||
        labels.some((label) => label.contains(parent)) ||
        !shown(parent)
      )
        continue;
      text = backwards ? `${node.textContent ?? ""} ${text}` : `${text} ${node.textContent ?? ""}`;
    }
    const words = text.replace(/\s+/g, " ").trim();

    return words.length <= 120
      ? words
      : backwards
        ? `…${words.slice(-119).trimStart()}`
        : `${words.slice(0, 119).trimEnd()}…`;
  };

  /** The nearest visible heading before `target` in tree order, within `scope`. */
  const headingBefore = (
    target: Element,
    scope: ParentNode,
    read = known(),
  ): string | undefined => {
    let headings = read.headings.get(scope);

    if (headings === undefined) {
      headings = Array.from(scope.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter(
        (element) => roleOf(element) === "heading",
      );
      read.headings.set(scope, headings);
    }
    // Headings are in tree order, so the nearest before the target is the last one before it.
    for (const heading of headings.toReversed()) {
      if ((heading.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) === 0)
        continue;
      const text = shown(heading) ? clean(textOf(heading), 120) : "";

      if (text !== "") return text;
    }

    return undefined;
  };

  /** Whether an element is pinned to the viewport, where the markup around it says nothing. */
  const pinned = (element: Element): boolean => {
    if (!isHtml(element)) return false;
    let top: HTMLElement = element;

    while (top.offsetParent !== null && isHtml(top.offsetParent)) top = top.offsetParent;

    return (
      top !== element.ownerDocument.body &&
      top !== element.ownerDocument.documentElement &&
      getComputedStyle(top).position === "fixed"
    );
  };

  const span = (cell: Element): number => Math.max(1, Number(cell.getAttribute("colspan")) || 1);
  const tables = "table,[role=table],[role=grid],[role=treegrid]";

  /** A cell's row and column names, or nothing when it is not in a table with either. */
  const tableContext = (cell: Element, read: Known): SubjectContext => {
    const row = cell.closest("tr,[role=row]");
    const table = row?.closest(tables);

    if (row === null || row === undefined || table === null || table === undefined) return {};
    let header = read.headers.get(table);

    if (header === undefined) {
      const first = table.querySelector(
        "thead tr, tr:has(> th), [role=row]:has(> [role=columnheader])",
      );

      header = first?.closest(tables) === table ? first : null;
      read.headers.set(table, header);
    }
    if (row === header) return {};
    const cells = Array.from(row.children);
    const index = cells.indexOf(cell);
    // A rank, a checkbox, a star or a price says where a row is, not which one it is.
    const lettered = (other: Element) => /\p{L}/u.test(textOf(other));

    const named =
      cells.find((other) => other.matches("th,[role=rowheader]") && lettered(other)) ??
      cells.find((other) => other !== cell && lettered(other));

    // Columns count spanned cells, so a cell after one spanning two is under the third header.
    let left = cells.slice(0, index).reduce((sum, other) => sum + span(other), 0);

    const over =
      index === -1 || header === null
        ? undefined
        : Array.from(header.children).find((candidate) => (left -= span(candidate)) < 0);

    return {
      row:
        named === undefined || named === cell ? undefined : clean(textOf(named), 60) || undefined,
      column: over === undefined ? undefined : clean(textOf(over), 60) || undefined,
    };
  };

  /** Where text around an element is read: its dialog, else its own tree, never across a shadow root. */
  const treeOf = (element: Element): ParentNode => {
    const root = element.getRootNode();

    return (
      element.closest("dialog,[role=dialog],[role=alertdialog]") ??
      (isDocument(root) ? (root.body ?? root) : isRoot(root) ? root : element.ownerDocument)
    );
  };

  /** The words around an element that say which one it is. */
  const contextOf = (element: Element, read = known()): SubjectContext => {
    const cell = element.closest(
      "td,th,[role=cell],[role=gridcell],[role=rowheader],[role=columnheader]",
    );

    const table = cell === null ? {} : tableContext(cell, read);
    const parent = element.parentElement;

    const scope =
      element.closest(groups) ??
      (parent === null || parent === element.ownerDocument.body || parent.tagName === "HTML"
        ? undefined
        : parent);

    const beside =
      table.row !== undefined || table.column !== undefined || scope === undefined
        ? ""
        : textBeside(element, scope, true);

    const heading = pinned(element) ? undefined : headingBefore(element, treeOf(element), read);

    return {
      ...table,
      label: beside.length > 40 ? `…${beside.slice(-39).trimStart()}` : beside || undefined,
      heading: heading === undefined ? undefined : clean(heading, 60),
    };
  };

  return { contextOf, groups, headingBefore, known, textBeside, treeOf };
};

export type ContextReader = ReturnType<typeof context>;
