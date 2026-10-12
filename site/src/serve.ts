// What the Worker does with a request, decided from its method, path and Accept header alone, so
// it is tested without Cloudflare: a page asked for as markdown gets its markdown, a replay's
// files come from the replays bucket, and everything else is the app's static build.
import { featuredReplay, markdownPathOf, pages } from "./pages.ts";

export type Served =
  /** A page as markdown: the asset at `path`, or a replay's page made on the spot. */
  | { readonly _tag: "Markdown"; readonly path: string }
  | { readonly _tag: "ReplayMarkdown"; readonly id: string }
  /** The 404 page as markdown, for an agent that asked for markdown at no page. */
  | { readonly _tag: "MissingMarkdown" }
  /** A page as HTML from the static build, with a Link header naming its markdown. */
  | { readonly _tag: "Page"; readonly markdown: string }
  /** A replay's file, by its key in the bucket. */
  | { readonly _tag: "ReplayFile"; readonly key: string }
  | { readonly _tag: "Asset" };

const quality = (accept: string, type: string) => {
  const entry = accept
    .split(",")
    .map((part) => part.trim().split(";"))
    .find(([name]) => name?.trim().toLowerCase() === type);

  if (entry === undefined) return 0;
  const q = entry.slice(1).find((parameter) => parameter.trim().startsWith("q="));
  const value = q === undefined ? 1 : Number(q.trim().slice(2));

  return Number.isFinite(value) ? value : 0;
};

/** Whether a client prefers markdown to HTML, as an agent that sends `Accept: text/markdown` does. */
export const prefersMarkdown = (accept: string | null) => {
  if (accept === null) return false;
  const markdown = quality(accept, "text/markdown");

  return markdown > 0 && markdown >= quality(accept, "text/html");
};

/** A replay id as the packer writes them: lowercase words and digits joined by hyphens. */
export const isReplayId = (id: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);

const replayKey = (rest: string) => {
  const [id, ...file] = rest.split("/");

  return id !== undefined &&
    isReplayId(id) &&
    file.length > 0 &&
    file.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
    ? `${id}/${file.join("/")}`
    : undefined;
};

/** The markdown a page path has, or undefined for a path that is no page. */
const pageMarkdown = (
  pathname: string,
): Extract<Served, { readonly _tag: "Markdown" | "ReplayMarkdown" }> | undefined => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (path === "/") return { _tag: "Markdown", path: "/index.md" };
  if (path === "/demo") return { _tag: "Markdown", path: "/demo.md" };
  if (path === "/try") return { _tag: "Markdown", path: markdownPathOf({ slug: "run-the-demo" }) };
  const doc = /^\/docs\/([a-z0-9-]+)$/.exec(path)?.[1];

  if (doc !== undefined && doc !== "index" && pages.some((page) => page.slug === doc))
    return { _tag: "Markdown", path: markdownPathOf({ slug: doc }) };
  const replay = /^\/replay\/([^/]+)$/.exec(path)?.[1];

  return replay !== undefined && isReplayId(replay)
    ? { _tag: "ReplayMarkdown", id: replay }
    : undefined;
};

export const serve = (method: string, pathname: string, accept: string | null): Served => {
  if (pathname.startsWith("/replays/")) {
    const key = method === "GET" || method === "HEAD" ? replayKey(pathname.slice(9)) : undefined;

    return key === undefined ? { _tag: "Asset" } : { _tag: "ReplayFile", key };
  }
  const replay = /^\/replay\/([a-z0-9-]+)\.md$/.exec(pathname)?.[1];

  if (replay !== undefined && isReplayId(replay)) return { _tag: "ReplayMarkdown", id: replay };
  const page = pageMarkdown(pathname);
  const markdown = prefersMarkdown(accept);

  if (page === undefined)
    return markdown && !/\.[a-z0-9]+$/i.test(pathname)
      ? { _tag: "MissingMarkdown" }
      : { _tag: "Asset" };
  if (markdown) return page;

  return {
    _tag: "Page",
    markdown: page._tag === "Markdown" ? page.path : `/replay/${page.id}.md`,
  };
};

/** The content type of a replay's file, by its extension. */
export const replayContentType = (key: string) => {
  const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase();

  return (
    {
      json: "application/json; charset=utf-8",
      mp4: "video/mp4",
      vtt: "text/vtt; charset=utf-8",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
    }[extension] ?? "application/octet-stream"
  );
};

/** A replay's page for agents: what it is and where its data is. */
export const replayMarkdown = (id: string) =>
  [
    id === featuredReplay ? "# Demo: an agent explores Polymarket" : `# Replay ${id}`,
    "",
    id === featuredReplay
      ? "An agent browses Polymarket on its own in a real Chromium and reports markets it found interesting, while a narrator model describes what each moment of the page shows and a voice model speaks it. The report is then checked against Polymarket's public API."
      : "A packed recording of a browser run: its video, narration, captions and the agent's steps.",
    "",
    `Watch it at [/replay/${id}](/replay/${id}). Its data:`,
    "",
    `- [replay.json](/replays/${id}/replay.json): every browser event on one host clock, the agent's steps and tool calls, when it thought, looked, acted, waited and reported, the narrated moments, the narration lines and the graded outcome.`,
    `- [captions.vtt](/replays/${id}/captions.vtt): the narration as WebVTT, timed from the video's start.`,
    `- [video.mp4](/replays/${id}/video.mp4): the screencast, H.264, with the narration as its audio track.`,
    "",
    "How it was made: [Moments and narration](/docs/moments-and-narration.md). Record your own: [Run the demo yourself](/docs/run-the-demo.md).",
    "",
  ].join("\n");
