// A code example and what running it produced, in one frame with a toggle between the two. Docs
// pages write one as a container directive, the code block first and its result after it:
//
//   :::Example
//   ```ts
//   …
//   ```
//
//   Run on 11 October 2026, it logged:
//
//   ```text output
//   …
//   ```
//   :::
import { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

export const ExampleTab = Schema.Literals(["Code", "Result"]);
export type ExampleTab = typeof ExampleTab.Type;

const tabs: ReadonlyArray<ExampleTab> = ["Code", "Result"];

export interface ExampleConfig<Message> {
  /** Unique on the page, for the tabs' ids. */
  readonly id: string;
  readonly tab: ExampleTab;
  readonly select: (tab: ExampleTab) => Message;
  /** The code as text, for the copy button. */
  readonly source: string;
  readonly copy: (text: string) => Message;
  readonly code: Html;
  readonly result: ReadonlyArray<Html>;
}

export const exampleView = <Message>(config: ExampleConfig<Message>, h: HtmlBuilder<Message>) =>
  h.div(
    [
      h.Class(
        "not-prose my-6 overflow-hidden rounded-xl bg-stone-950 text-stone-100 ring-1 ring-stone-800",
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-1 border-b border-white/10 px-2 py-1.5")],
        [
          h.div(
            [h.Role("tablist"), h.AriaLabel("Code or result"), h.Class("flex gap-1")],
            tabs.map((tab) =>
              h.button(
                [
                  h.Type("button"),
                  h.Role("tab"),
                  h.Id(`${config.id}-${tab}`),
                  h.AriaSelected(config.tab === tab),
                  h.AriaControls(`${config.id}-panel`),
                  h.Tabindex(config.tab === tab ? 0 : -1),
                  h.Class(
                    "rounded-md px-2.5 py-1 text-xs font-medium text-stone-400 transition hover:text-stone-100 aria-selected:bg-white/10 aria-selected:text-white",
                  ),
                  h.OnClick(config.select(tab)),
                ],
                [tab],
              ),
            ),
          ),
          config.tab === "Code"
            ? h.button(
                [
                  h.Type("button"),
                  h.Class(
                    "ml-auto rounded-md px-2 py-1 text-xs text-stone-400 transition hover:bg-white/10 hover:text-stone-100",
                  ),
                  h.OnClick(config.copy(config.source)),
                ],
                ["Copy"],
              )
            : h.empty,
        ],
      ),
      h.div(
        [
          h.Role("tabpanel"),
          h.Id(`${config.id}-panel`),
          h.AriaLabelledBy(`${config.id}-${config.tab}`),
          h.Class(
            "[&>p]:mx-4 [&>p]:my-0 [&>p]:pt-3 [&>p]:text-[0.8125rem] [&>p]:leading-6 [&>p]:text-stone-400 [&>p_a]:text-stone-200 [&>p_code]:bg-white/10 [&>p_code]:text-stone-200",
          ),
        ],
        config.tab === "Code" ? [config.code] : config.result,
      ),
    ],
  );
