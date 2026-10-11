// The deployed site's Worker. It runs first on page paths and /replays/*: it answers an agent that
// asks for markdown with the page's markdown, names that markdown in a Link header on the HTML,
// and streams replays from R2 with range requests, so the player can seek. Everything else is the
// static build, served through the ASSETS binding.
import { replayContentType, replayMarkdown, serve } from "./serve.ts";

/** The static build. */
export interface Assets {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** The parts of an R2 object the Worker reads. */
export interface ReplayObject {
  readonly size: number;
  readonly httpEtag: string;
  readonly range?: { readonly offset?: number; readonly length?: number; readonly suffix?: number };
  readonly writeHttpMetadata: (headers: Headers) => void;
}

export interface ReplayObjectBody extends ReplayObject {
  readonly body: ReadableStream;
}

/** The replays bucket: `<id>/replay.json`, `<id>/video.mp4`, `<id>/captions.vtt`, `<id>/moments/*`. */
export interface Replays {
  readonly get: (
    key: string,
    options: { readonly range: Headers; readonly onlyIf: Headers },
  ) => Promise<ReplayObjectBody | ReplayObject | null>;
  readonly head: (key: string) => Promise<ReplayObject | null>;
}

export interface Env {
  readonly ASSETS: Assets;
  readonly REPLAYS: Replays;
}

const markdown = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" },
  });

const withHeaders = (response: Response, headers: Record<string, string>) => {
  const next = new Response(response.body, response);

  for (const [name, value] of Object.entries(headers)) next.headers.set(name, value);

  return next;
};

const replayHeaders = (key: string, object: ReplayObject) => {
  const headers = new Headers();

  object.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", replayContentType(key));
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // A replay can be re-recorded under its id, so caches check back within minutes.
  headers.set("Cache-Control", "public, max-age=300");

  return headers;
};

const replayFile = async (request: Request, env: Env, key: string) => {
  if (request.method === "HEAD") {
    const object = await env.REPLAYS.head(key);

    return object === null
      ? new Response(null, { status: 404 })
      : new Response(null, {
          headers: {
            ...Object.fromEntries(replayHeaders(key, object)),
            "Content-Length": String(object.size),
          },
        });
  }
  const object = await env.REPLAYS.get(key, { range: request.headers, onlyIf: request.headers });

  if (object === null) return new Response("Not found", { status: 404 });
  const headers = replayHeaders(key, object);

  if (!("body" in object))
    return new Response(null, {
      status: request.headers.has("If-None-Match") ? 304 : 412,
      headers,
    });
  const { range, size } = object;

  if (range === undefined || !request.headers.has("Range")) {
    headers.set("Content-Length", String(size));

    return new Response(object.body, { headers });
  }
  const start = range.suffix === undefined ? (range.offset ?? 0) : size - range.suffix;
  const end = range.length === undefined ? size - 1 : start + range.length - 1;

  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));

  return new Response(object.body, { status: 206, headers });
};

export const respond = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const served = serve(request.method, url.pathname, request.headers.get("Accept"));

  switch (served._tag) {
    case "ReplayFile":
      return replayFile(request, env, served.key);
    case "ReplayMarkdown":
      return markdown(replayMarkdown(served.id));
    case "Markdown": {
      const asset = await env.ASSETS.fetch(new Request(new URL(served.path, url), request));

      return withHeaders(asset, { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept" });
    }
    case "MissingMarkdown": {
      const asset = await env.ASSETS.fetch(new Request(new URL("/404.md", url), request));

      return markdown(await asset.text(), 404);
    }
    case "Page":
      return withHeaders(await env.ASSETS.fetch(request), {
        Link: `<${served.markdown}>; rel="alternate"; type="text/markdown"`,
        Vary: "Accept",
      });
    case "Asset":
      return env.ASSETS.fetch(request);
  }
};

export default { fetch: respond };
