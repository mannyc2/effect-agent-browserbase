// The docs pages' markdown, compiled at build time by @foldkit/markdown, and how the site renders
// it: prose styled for reading, headings that link to themselves, code blocks with a copy button,
// and islands that place a live view, such as a replay's player, in the prose.
import * as Markdown from "@foldkit/markdown";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { islandAttributes } from "./islands.ts";
import { type Page, pages } from "./pages.ts";

const sources: Readonly<Record<string, unknown>> = import.meta.glob("../docs/*.md", {
  eager: true,
  import: "default",
});

/** A page's compiled markdown. */
export const documentOf = (page: Pick<Page, "slug">): Option.Option<Markdown.MarkdownDocument> =>
  Option.map(Option.fromNullishOr(sources[`../docs/${page.slug}.md`]), Markdown.decodeDocument);

export const pageOf = (slug: string) =>
  Option.fromNullishOr(pages.find((page) => page.slug === slug));

const islandsIn = (blocks: ReadonlyArray<Markdown.Block>): ReadonlyArray<Markdown.Island> =>
  blocks.flatMap((block) =>
    block._tag === "Island"
      ? [block, ...islandsIn(block.blocks)]
      : block._tag === "List"
        ? block.items.flatMap((item) => islandsIn(item.blocks))
        : block._tag === "Blockquote"
          ? islandsIn(block.blocks)
          : [],
  );

/** The replays a page's prose places, by id, in order. */
export const replaysOf = (page: Pick<Page, "slug">): ReadonlyArray<string> =>
  Option.match(documentOf(page), {
    onNone: () => [],
    onSome: (document) =>
      islandsIn(document.blocks).flatMap((island) =>
        island.name === "Replay" && island.attributes.id !== undefined
          ? [island.attributes.id]
          : [],
      ),
  });

const plainText = (content: ReadonlyArray<Markdown.Inline>): string =>
  content
    .map((inline) =>
      inline._tag === "Text" || inline._tag === "InlineCode"
        ? inline.value
        : inline._tag === "Emphasis" ||
            inline._tag === "Strong" ||
            inline._tag === "Strikethrough" ||
            inline._tag === "Link"
          ? plainText(inline.content)
          : "",
    )
    .join("");

/** A heading's anchor: its words, lowercased and joined by hyphens. */
export const anchorOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The page's own title is the site's, so the document's first heading is left to the page. */
export const withoutTitle = (document: Markdown.MarkdownDocument): Markdown.MarkdownDocument => ({
  ...document,
  blocks: document.blocks[0]?._tag === "Heading" ? document.blocks.slice(1) : document.blocks,
});

/** The second-level headings, for a page's table of contents. */
export const sectionsOf = (document: Markdown.MarkdownDocument) =>
  document.blocks.flatMap((block) =>
    block._tag === "Heading" && block.level === 2 ? [plainText(block.content)] : [],
  );

export interface ProseConfig<Message> {
  readonly replay: (id: string) => Html;
  readonly copy: (text: string) => Message;
}

const headingClasses: Readonly<Record<number, string>> = {
  1: "text-3xl font-semibold tracking-tight",
  2: "mt-12 mb-3 text-xl font-semibold tracking-tight",
  3: "mt-8 mb-2 text-base font-semibold",
};

/** A document as the site's prose. */
export const prose = <Message>(
  document: Markdown.MarkdownDocument,
  config: ProseConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Markdown.view(document, {
    islands: Markdown.islandsFor(islandAttributes, {
      Replay: ({ id }) => h.div([h.Class("my-8")], [config.replay(id)]),
    }),
    views: {
      Heading: (heading, content) => {
        const id = anchorOf(plainText(heading.content));
        const tag = heading.level === 2 ? h.h2 : heading.level === 3 ? h.h3 : h.h4;

        return tag(
          [
            h.Id(id),
            h.Class(`group scroll-mt-20 ${headingClasses[heading.level] ?? "font-semibold"}`),
          ],
          [
            ...content,
            h.a(
              [
                h.Href(`#${id}`),
                h.AriaLabel("Link to this section"),
                h.Class("ml-2 text-stone-400 opacity-0 group-hover:opacity-100"),
              ],
              ["#"],
            ),
          ],
        );
      },
      Paragraph: (_, content) => h.p([h.Class("my-4 leading-7")], content),
      Link: (link, content) =>
        h.a(
          [
            h.Href(link.url),
            h.Class(
              "font-medium text-stone-900 underline decoration-amber-500/60 decoration-2 underline-offset-[3px] hover:decoration-amber-500 dark:text-stone-100",
            ),
          ],
          content,
        ),
      InlineCode: ({ value }) =>
        h.code(
          [
            h.Class(
              "rounded bg-stone-200/70 px-1 py-0.5 font-mono text-[0.85em] text-stone-900 dark:bg-stone-800 dark:text-stone-100",
            ),
          ],
          [value],
        ),
      CodeBlock: ({ value, maybeLanguage }) =>
        h.div(
          [h.Class("group relative my-6")],
          [
            h.pre(
              [
                h.Class(
                  "overflow-x-auto rounded-xl bg-stone-950 px-4 py-3.5 font-mono text-[0.8125rem] leading-relaxed text-stone-100 ring-1 ring-stone-800",
                ),
                h.DataAttribute(
                  "language",
                  Option.getOrElse(maybeLanguage, () => "text"),
                ),
              ],
              [h.code([], [value])],
            ),
            h.button(
              [
                h.Type("button"),
                h.Class(
                  "absolute top-2 right-2 rounded-md bg-stone-800 px-2 py-1 text-xs text-stone-300 opacity-0 transition group-hover:opacity-100 hover:bg-stone-700 focus:opacity-100",
                ),
                h.OnClick(config.copy(value)),
              ],
              ["Copy"],
            ),
          ],
        ),
      List: (list, items) =>
        (list.isOrdered ? h.ol : h.ul)(
          [
            h.Class(
              `my-4 flex flex-col gap-1.5 pl-5 ${list.isOrdered ? "list-decimal" : "list-disc"}`,
            ),
          ],
          items,
        ),
      ListItem: (_, blocks) => h.li([h.Class("pl-1 leading-7 [&>p]:my-0")], blocks),
      Blockquote: (_, blocks) =>
        h.blockquote(
          [h.Class("my-6 border-l-2 border-amber-500 pl-4 text-stone-600 dark:text-stone-400")],
          blocks,
        ),
      Table: (_, headerRow, bodyRows) =>
        h.div(
          [h.Class("my-6 overflow-x-auto rounded-xl ring-1 ring-stone-200 dark:ring-stone-800")],
          [
            h.table(
              [h.Class("w-full text-left text-sm")],
              [
                h.thead([h.Class("bg-stone-100 dark:bg-stone-900")], [headerRow]),
                h.tbody([h.Class("divide-y divide-stone-200 dark:divide-stone-800")], bodyRows),
              ],
            ),
          ],
        ),
      TableCell: (_, content, _alignment, isHeader) =>
        isHeader
          ? h.th([h.Class("px-3 py-2 font-semibold whitespace-nowrap")], content)
          : h.td([h.Class("px-3 py-2 align-top")], content),
    },
  });
