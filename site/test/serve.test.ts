// The deployed Worker: markdown for agents that ask for it, a Link header naming it on the HTML,
// and replays from R2 with ranges, so the player can seek.
import { assert, describe, it } from "@effect/vitest";

import { prefersMarkdown, serve } from "../src/serve.ts";
import { type Env, type ReplayObject, type ReplayObjectBody, respond } from "../src/worker.ts";

describe("serve", () => {
  it("answers a page asked for as markdown with its markdown", () => {
    assert.deepStrictEqual(serve("GET", "/", "text/markdown"), {
      _tag: "Markdown",
      path: "/index.md",
    });
    assert.deepStrictEqual(serve("GET", "/docs/get-started", "text/markdown, text/html;q=0.5"), {
      _tag: "Markdown",
      path: "/docs/get-started.md",
    });
    assert.deepStrictEqual(serve("GET", "/try", "text/markdown"), {
      _tag: "Markdown",
      path: "/docs/run-the-demo.md",
    });
    assert.deepStrictEqual(serve("GET", "/replay/polymarket", "text/markdown"), {
      _tag: "ReplayMarkdown",
      id: "polymarket",
    });
  });

  it("serves a browser the page, naming its markdown", () => {
    const accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    assert.deepStrictEqual(serve("GET", "/docs/browserbase", accept), {
      _tag: "Page",
      markdown: "/docs/browserbase.md",
    });
    assert.deepStrictEqual(serve("GET", "/demo", null), { _tag: "Page", markdown: "/demo.md" });
  });

  it("leaves paths that are no page to the static build", () => {
    assert.deepStrictEqual(serve("GET", "/docs/no-such-page", null), { _tag: "Asset" });
    assert.deepStrictEqual(serve("GET", "/assets/entry.js", "text/markdown"), { _tag: "Asset" });
    assert.deepStrictEqual(serve("GET", "/docs/no-such-page", "text/markdown"), {
      _tag: "MissingMarkdown",
    });
  });

  it("keys a replay's files in the bucket and refuses keys outside it", () => {
    assert.deepStrictEqual(serve("GET", "/replays/polymarket/moments/0-1.jpg", null), {
      _tag: "ReplayFile",
      key: "polymarket/moments/0-1.jpg",
    });
    assert.deepStrictEqual(serve("GET", "/replays/polymarket/../secret", null), { _tag: "Asset" });
    assert.deepStrictEqual(serve("GET", "/replays/Polymarket/video.mp4", null), { _tag: "Asset" });
    assert.deepStrictEqual(serve("PUT", "/replays/polymarket/video.mp4", null), { _tag: "Asset" });
  });

  it("weighs markdown against HTML by quality", () => {
    assert.isTrue(prefersMarkdown("text/markdown"));
    assert.isTrue(prefersMarkdown("text/html;q=0.5, text/markdown"));
    assert.isFalse(prefersMarkdown("text/html, text/markdown;q=0.5"));
    assert.isFalse(prefersMarkdown("*/*"));
    assert.isFalse(prefersMarkdown(null));
  });
});

const video = new Uint8Array(100).map((_, index) => index);

const object = (range?: ReplayObject["range"]): ReplayObjectBody => {
  const start = range?.offset ?? 0;
  const length = range?.length ?? video.length - start;

  return {
    size: video.length,
    httpEtag: '"v1"',
    ...(range === undefined ? {} : { range }),
    writeHttpMetadata: () => {},
    body: new Blob([video.slice(start, start + length)]).stream(),
  };
};

const env = (seen: Array<string> = []): Env => ({
  ASSETS: {
    fetch: async (request) => {
      seen.push(new URL(request.url).pathname);

      return new Response(new URL(request.url).pathname === "/404.md" ? "# Not found" : "asset", {
        headers: { "Content-Type": "text/html" },
      });
    },
  },
  REPLAYS: {
    get: async (key, { range, onlyIf }) => {
      if (key !== "polymarket/video.mp4") return null;
      if (onlyIf.get("If-None-Match") === '"v1"') {
        const { body: _, ...unchanged } = object();

        return unchanged;
      }
      const match = /bytes=(\d+)-(\d+)/.exec(range.get("Range") ?? "");

      return object(
        match === null
          ? undefined
          : { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 },
      );
    },
    head: async (key) => (key === "polymarket/video.mp4" ? object() : null),
  },
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://site.test${path}`, { headers });

describe("respond", () => {
  it("serves a page's markdown asset as markdown, varying on Accept", async () => {
    const seen: Array<string> = [];

    const response = await respond(
      get("/docs/agent-tools", { Accept: "text/markdown" }),
      env(seen),
    );

    assert.deepStrictEqual(seen, ["/docs/agent-tools.md"]);
    assert.strictEqual(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
    assert.strictEqual(response.headers.get("Vary"), "Accept");
  });

  it("names the markdown of a page served as HTML in a Link header", async () => {
    const response = await respond(get("/docs/agent-tools"), env());

    assert.strictEqual(
      response.headers.get("Link"),
      '</docs/agent-tools.md>; rel="alternate"; type="text/markdown"',
    );
  });

  it("answers markdown for no page with the 404 page", async () => {
    const response = await respond(get("/nowhere", { Accept: "text/markdown" }), env());

    assert.strictEqual(response.status, 404);
    assert.strictEqual(await response.text(), "# Not found");
  });

  it("streams a replay's video whole, by range and by head", async () => {
    const whole = await respond(get("/replays/polymarket/video.mp4"), env());

    assert.strictEqual(whole.status, 200);
    assert.strictEqual(whole.headers.get("Content-Type"), "video/mp4");
    assert.strictEqual(whole.headers.get("Accept-Ranges"), "bytes");
    assert.strictEqual((await whole.arrayBuffer()).byteLength, 100);

    const part = await respond(
      get("/replays/polymarket/video.mp4", { Range: "bytes=10-19" }),
      env(),
    );

    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get("Content-Range"), "bytes 10-19/100");
    assert.deepStrictEqual(
      [...new Uint8Array(await part.arrayBuffer())],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    );

    const head = await respond(
      new Request("https://site.test/replays/polymarket/video.mp4", { method: "HEAD" }),
      env(),
    );

    assert.strictEqual(head.headers.get("Content-Length"), "100");
  });

  it("answers an unchanged replay with 304 and a missing one with 404", async () => {
    const unchanged = await respond(
      get("/replays/polymarket/video.mp4", { "If-None-Match": '"v1"' }),
      env(),
    );

    assert.strictEqual(unchanged.status, 304);
    assert.strictEqual((await respond(get("/replays/polymarket/missing.mp4"), env())).status, 404);
  });
});
