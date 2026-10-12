// The site for agents: every page as markdown, llms.txt and llms-full.txt, a JSON index of the
// pages, robots.txt with content signals and a markdown 404. The dev server serves them; a build
// writes them beside the app, with one HTML entry per page whose head names its title, summary
// and markdown.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Plugin } from "vite";

import { featuredReplay, markdownPathOf, type Page, pages, pathOf, site } from "./src/pages.ts";
import { prefersMarkdown, replayMarkdown, serve } from "./src/serve.ts";

/**
 * A page's markdown as an agent reads it: islands become links to what they show, and an
 * example is its code followed by its result, as the page's prose introduces it.
 */
export const agentMarkdown = (source: string) =>
  source
    .replace(/^:::(Example)?[ \t]*\n/gm, "")
    .replace(/\]\((\/[^)\s#]*)(#[^)]*)?\)/g, (link, path: string, hash = "") => {
      const served = serve("GET", path, "text/markdown");

      return served._tag === "Markdown"
        ? `](${served.path}${hash})`
        : served._tag === "ReplayMarkdown"
          ? `](/replay/${served.id}.md${hash})`
          : link;
    })
    .replace(
      /^::Replay\{id="([a-z0-9-]+)"\}[ \t]*$/gm,
      (_, id: string) =>
        `> **Replay \`${id}\`.** Watch it at [/replay/${id}](/replay/${id}); read it as [replay.json](/replays/${id}/replay.json) and [captions.vtt](/replays/${id}/captions.vtt), or as [markdown](/replay/${id}.md).`,
    );

const notFound = [
  "# Not found",
  "",
  `Nothing is at this path on ${site.name}'s site.`,
  "",
  "- The pages for agents: [/llms.txt](/llms.txt)",
  "- Every page in one file: [/llms-full.txt](/llms-full.txt)",
  "- The pages as JSON: [/api/v1/pages.json](/api/v1/pages.json)",
  "",
  "Every page is markdown at its path plus `.md`, or at its path with `Accept: text/markdown`.",
  "",
].join("\n");

const robots = [
  "User-agent: *",
  "Allow: /",
  "Content-Signal: ai-train=yes, search=yes, ai-input=yes",
  "",
  "# Every page is also markdown: add `.md` to its path, or ask for it with",
  "# `Accept: text/markdown`.",
  "# /llms.txt        the pages, with one-line summaries",
  "# /llms-full.txt   every page in one file",
  "# /api/v1/pages.json",
  "",
].join("\n");

const llmsTxt = () =>
  [
    `# ${site.name}`,
    "",
    `> ${site.tagline}`,
    "",
    "effect-browser drives Chromium or a Browserbase session from Effect: pages, a compact outline a model can act on, screencast frames, and moments, an account in pictures and words of what a page showed over a window of time. Agents run on Yielded Agent. Every page below is markdown.",
    "",
    ...(["Start", "Guides", "Site"] as const).flatMap((section) => [
      `## ${section}`,
      "",
      ...pages
        .filter((page) => page.section === section)
        .map((page) => `- [${page.title}](${markdownPathOf(page)}): ${page.summary}`),
      "",
    ]),
    "## Optional",
    "",
    "- [Every page in one file](/llms-full.txt)",
    "- [The pages as JSON](/api/v1/pages.json): slug, title, summary, section and both URLs",
    `- [The featured demo](/demo.md): its replay's data files`,
    `- [Source](${site.repository}): the packages, the demo runner and this site`,
    "",
  ].join("\n");

/** Every file the agent surface serves, by path, from the pages' markdown sources. */
export const agentFiles = (
  sourceOf: (page: Page) => string,
): ReadonlyMap<string, { readonly type: string; readonly body: string }> => {
  const markdown = pages.map((page) => [page, agentMarkdown(sourceOf(page))] as const);
  const md = (body: string) => ({ type: "text/markdown; charset=utf-8", body });
  const text = (body: string) => ({ type: "text/plain; charset=utf-8", body });

  return new Map([
    ...markdown.map(([page, body]) => [markdownPathOf(page), md(body)] as const),
    ["/demo.md", md(replayMarkdown(featuredReplay))],
    ["/404.md", md(notFound)],
    ["/llms.txt", text(llmsTxt())],
    [
      "/llms-full.txt",
      text(
        markdown
          .map(([page, body]) => `<!-- ${markdownPathOf(page)} -->\n\n${body.trim()}\n`)
          .join("\n---\n\n"),
      ),
    ],
    [
      "/api/v1/pages.json",
      {
        type: "application/json; charset=utf-8",
        body: `${JSON.stringify(
          {
            name: site.name,
            tagline: site.tagline,
            repository: site.repository,
            pages: pages.map((page) => ({
              slug: page.slug,
              title: page.title,
              summary: page.summary,
              section: page.section,
              url: pathOf(page),
              markdown: markdownPathOf(page),
            })),
            featuredReplay: {
              id: featuredReplay,
              url: "/demo",
              files: ["replay.json", "captions.vtt", "video.mp4"].map(
                (file) => `/replays/${featuredReplay}/${file}`,
              ),
            },
          },
          null,
          2,
        )}\n`,
      },
    ],
    ["/robots.txt", text(robots)],
  ]);
};

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** The built index.html with a page's title, summary and markdown in its head. */
export const pageHtml = (
  html: string,
  head: { readonly title: string; readonly summary: string; readonly markdown: string },
) =>
  html
    .replace(/<title>[^<]*<\/title>/, `<title>${escape(head.title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${escape(head.summary)}$2`)
    .replace(
      /(<link\s+rel="alternate"\s+type="text\/markdown"\s+href=")[^"]*(")/,
      `$1${escape(head.markdown)}$2`,
    );

/** The HTML entries a build writes: one per page path, so its head is right before the app runs. */
const entries = (): ReadonlyArray<{
  readonly file: string;
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
}> => [
  ...pages.map((page) => ({
    file: page.slug === "index" ? "index.html" : `docs/${page.slug}.html`,
    title: page.slug === "index" ? site.name : `${page.title} – ${site.name}`,
    summary: page.summary,
    markdown: markdownPathOf(page),
  })),
  {
    file: "demo.html",
    title: `Demo – ${site.name}`,
    summary: "An agent explores Polymarket while a narrator watches and speaks.",
    markdown: "/demo.md",
  },
  {
    file: "try.html",
    title: `Try it – ${site.name}`,
    summary: "Record a narrated take of the demo on your own machine.",
    markdown: markdownPathOf({ slug: "run-the-demo" }),
  },
];

export const agentSurface = (): Plugin => {
  let root = process.cwd();

  const files = () =>
    agentFiles((page) => readFileSync(join(root, "docs", `${page.slug}.md`), "utf8"));

  return {
    name: "effect-browser-agent-surface",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");

        // The app imports the docs as modules, at the same paths with a query or as scripts.
        if (url.search !== "" || request.headers["sec-fetch-dest"] === "script") return next();
        const served = serve(request.method ?? "GET", url.pathname, request.headers.accept ?? null);

        const path =
          served._tag === "Markdown"
            ? served.path
            : served._tag === "MissingMarkdown"
              ? "/404.md"
              : url.pathname;

        const file =
          served._tag === "ReplayMarkdown"
            ? { type: "text/markdown; charset=utf-8", body: replayMarkdown(served.id) }
            : files().get(path);

        if (file === undefined) return next();
        response.statusCode = served._tag === "MissingMarkdown" ? 404 : 200;
        response.setHeader("Content-Type", file.type);
        if (prefersMarkdown(request.headers.accept ?? null)) response.setHeader("Vary", "Accept");
        response.end(file.body);
      });
    },
    async writeBundle(options, bundle) {
      const dir = options.dir ?? join(root, "dist");
      const index = bundle["index.html"];

      const write = async (path: string, body: string) => {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), body);
      };

      for (const [path, file] of files()) await write(path, file.body);
      if (index?.type !== "asset") return;
      const html = String(index.source);

      for (const entry of entries()) await write(entry.file, pageHtml(html, entry));
    },
  };
};
