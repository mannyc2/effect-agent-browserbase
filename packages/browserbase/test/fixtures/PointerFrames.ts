import { createServer } from "node:http";

import { Effect } from "effect";

import { NativeFixtureError } from "./LocalBrowser.ts";

const document = (contents: string) => `<!doctype html><style>
  html,body{margin:0} *{box-sizing:border-box}
  #cover{position:fixed;inset:0;z-index:99;background:white}
</style>${contents}<div id="cover" hidden></div><script>
  window.moves=[];
  document.addEventListener("mousemove",e=>window.moves.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted}));
</script>`;

const attribute = (html: string) => html.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** A different loopback origin supplies the deepest frame; no browser/controller lives here. */
export const pointerFrameSite = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          document(
            '<button id="target" style="position:absolute;left:20px;top:20px;width:100px;height:40px">Nested</button>',
          ),
        );
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();

      if (address === null || typeof address === "string")
        throw new Error("No pointer fixture port");
      const origin = `http://127.0.0.1:${address.port}`;

      const middle = document(
        `<iframe name="leaf" style="position:absolute;left:20px;top:20px;width:280px;height:200px;border:3px solid black" src="${origin}/leaf"></iframe>`,
      );

      return {
        origin,
        page: document(
          `<div id="clip" style="position:absolute;left:40px;top:30px;width:410px;height:310px;overflow:hidden">
            <iframe name="outer" style="display:block;width:400px;height:300px;border:4px solid black" srcdoc="${attribute(middle)}"></iframe>
          </div>`,
        ),
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    },
    catch: (cause) => NativeFixtureError.make({ operation: "pointer frame site", cause }),
  }),
  (site) => Effect.promise(site.close),
);
