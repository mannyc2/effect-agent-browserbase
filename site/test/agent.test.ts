// The site for agents: every page's markdown, with its replays as links to their data, and the
// indexes that list the pages.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { agentFiles, agentMarkdown, pageHtml } from "../agent.ts";
import { markdownPathOf, pages } from "../src/pages.ts";

const sourceOf = (page: { readonly slug: string }) =>
  readFileSync(join(import.meta.dirname, "..", "docs", `${page.slug}.md`), "utf8");

const files = agentFiles(sourceOf);

describe("agentMarkdown", () => {
  it("turns a replay island into links to the replay and its data", () => {
    const markdown = agentMarkdown('Before.\n\n::Replay{id="polymarket"}\n\nAfter.');

    assert.include(markdown, "[/replay/polymarket](/replay/polymarket)");
    assert.include(markdown, "(/replays/polymarket/replay.json)");
    assert.include(markdown, "(/replays/polymarket/captions.vtt)");
    assert.notInclude(markdown, "::Replay");
  });

  it("points links to pages at their markdown, keeping anchors and other links", () => {
    assert.strictEqual(
      agentMarkdown(
        "[a](/docs/get-started#install) [b](/) [c](/llms.txt) [d](https://example.com/docs/x)",
      ),
      "[a](/docs/get-started.md#install) [b](/index.md) [c](/llms.txt) [d](https://example.com/docs/x)",
    );
  });
});

describe("agentFiles", () => {
  it("serves every page as markdown that opens with its title", () => {
    for (const page of pages) {
      const file = files.get(markdownPathOf(page));

      assert.isDefined(file);
      assert.isTrue(file?.body.startsWith(`# ${page.title}\n`), page.slug);
    }
  });

  it("lists every page in llms.txt with its summary, and all of them in llms-full.txt", () => {
    const llms = files.get("/llms.txt")?.body ?? "";
    const full = files.get("/llms-full.txt")?.body ?? "";

    for (const page of pages) {
      assert.include(llms, `(${markdownPathOf(page)}): ${page.summary}`);
      assert.include(full, `# ${page.title}\n`);
    }
  });

  it("indexes the pages as JSON", () => {
    const index = JSON.parse(files.get("/api/v1/pages.json")?.body ?? "{}") as {
      readonly pages: ReadonlyArray<{ readonly slug: string; readonly markdown: string }>;
    };

    assert.deepStrictEqual(
      index.pages.map((page) => page.slug),
      pages.map((page) => page.slug),
    );
  });

  it("signals content use in robots.txt", () => {
    assert.include(files.get("/robots.txt")?.body ?? "", "Content-Signal: ai-train=yes");
  });

  it("never names a downstream application", () => {
    for (const [path, file] of files) assert.notMatch(file.body, /bando/i, path);
  });
});

describe("pageHtml", () => {
  it("writes a page's title, summary and markdown into the built head", () => {
    const html = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");

    const page = pageHtml(html, {
      title: "Get started – effect-browser",
      summary: "Install & run",
      markdown: "/docs/get-started.md",
    });

    assert.include(page, "<title>Get started – effect-browser</title>");
    assert.include(page, 'content="Install &amp; run"');
    assert.include(page, 'type="text/markdown" href="/docs/get-started.md"');
  });
});
