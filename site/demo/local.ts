// The local runner: under `bun run dev`, the Try page records takes on the visitor's own machine.
// The dev server serves LocalApi under /local, and each take is `bun run demo take` in a child
// process, one at a time: its output is the take's log, and its replay is packed into
// public/replays/, which the dev server serves from disk. A deployed site has no runner.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";

import { NodeHttpPlatform, NodeServices } from "@effect/platform-node";
import { Config, DateTime, Effect, Layer, Option, Ref, Stream } from "effect";
import { Etag, HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Plugin } from "vite";

import { LocalApi, type Take, TakeState } from "../src/local.ts";
import { replayContentType, serve } from "../src/serve.ts";
import { defaults } from "./defaults.ts";

/** The lines of output a take keeps, newest last. */
const logLines = 200;

const site = new URL("..", import.meta.url).pathname;

/** What a take still needs from the shell that started the dev server, in words. */
const missing = Effect.gen(function* () {
  const key = yield* Config.option(Config.Redacted("OPENROUTER_API_KEY"));
  const live = yield* Config.option(Config.String("EFFECT_BROWSER_BENCH_LIVE"));

  return [
    ...(Option.isNone(key) ? ["OPENROUTER_API_KEY: the agent and its voice run on it"] : []),
    ...(Option.getOrUndefined(live) === "1"
      ? []
      : ["EFFECT_BROWSER_BENCH_LIVE=1: your opt-in to paid model calls"]),
  ];
}).pipe(Effect.orDie);

const Runner = HttpApiBuilder.group(
  LocalApi,
  "LocalRunner",
  Effect.fn("LocalRunner")(function* (handlers) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const takes = yield* Ref.make<ReadonlyMap<string, TakeState>>(new Map());
    const current = yield* Ref.make<string | undefined>(undefined);

    const update = (id: string, next: (state: TakeState) => TakeState) =>
      Ref.update(takes, (all) => {
        const state = all.get(id);

        return state === undefined ? all : new Map(all).set(id, next(state));
      });

    const said = (id: string, line: string) =>
      update(id, (state) =>
        state._tag === "Running"
          ? TakeState.cases.Running.make({ log: [...state.log, line].slice(-logLines) })
          : state,
      );

    const ended = (id: string, reason: string | undefined) =>
      update(id, ({ log }) =>
        reason === undefined
          ? TakeState.cases.Packed.make({ log, replay: id })
          : TakeState.cases.Failed.make({ log, reason }),
      );

    const record = (id: string, take: Take) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "--conditions=@effect-browser/source",
              "demo/main.ts",
              "take",
              "--id",
              id,
              "--model",
              take.model,
              "--max-usd",
              String(take.maxUsd),
            ],
            { cwd: site },
          ),
        );

        yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => said(id, line)),
        );
        const code = yield* handle.exitCode;

        yield* ended(id, code === 0 ? undefined : `the take exited with code ${code}`);
      }).pipe(
        Effect.scoped,
        Effect.catch((error) => ended(id, `the take could not run: ${error.message}`)),
        Effect.ensuring(Ref.set(current, undefined)),
      );

    return handlers
      .handle("status", () =>
        Effect.map(missing, (needs) => ({
          missing: needs,
          defaults: { model: defaults.model, maxUsd: defaults.maxUsd },
        })),
      )
      .handle("start", ({ payload }) =>
        Effect.gen(function* () {
          const running = yield* Ref.get(current);

          // One take at a time: a second start follows the take already running.
          if (running !== undefined) return { id: running };

          const stamp = DateTime.formatIso(yield* DateTime.now)
            .replace(/\D/g, "")
            .slice(0, 14);

          const id = `polymarket-${stamp}`;

          yield* Ref.set(current, id);
          yield* Ref.update(takes, (all) =>
            new Map(all).set(id, TakeState.cases.Running.make({ log: [] })),
          );
          yield* Effect.forkIn(record(id, payload), scope);

          return { id };
        }),
      )
      .handle("take", ({ params }) =>
        Effect.map(
          Ref.get(takes),
          (all) =>
            all.get(params.id) ??
            TakeState.cases.Failed.make({ log: [], reason: "this dev server ran no such take" }),
        ),
      );
  }),
);

const toRequest = (request: IncomingMessage) =>
  new Request(new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`), {
    method: request.method ?? "GET",
    headers: Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ) as Array<[string, string]>,
    ...(request.method === "GET" || request.method === "HEAD"
      ? {}
      : { body: Readable.toWeb(request) as ReadableStream, duplex: "half" }),
  });

const send = async (to: ServerResponse, response: Response) => {
  to.statusCode = response.status;
  response.headers.forEach((value, name) => to.setHeader(name, value));
  to.end(Buffer.from(await response.arrayBuffer()));
};

/**
 * Answers /replays/* from public/replays/ on disk, with byte ranges so the player can seek. Vite
 * lists public files when it starts and follows its file watcher after that, which misses a
 * replay packed again in place while it runs; a take recorded from the Try page is one.
 */
const replayFile = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
  const served = serve(
    request.method ?? "GET",
    new URL(request.url ?? "/", "http://localhost").pathname,
    null,
  );

  if (served._tag !== "ReplayFile") return next();
  const file = join(site, "public", "replays", served.key);
  const found = await stat(file).catch(() => undefined);

  if (found === undefined || !found.isFile()) return next();
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  const size = found.size;
  const start = range === null ? 0 : range[1] === "" ? size - Number(range[2]) : Number(range[1]);
  const end = range === null || range[1] === "" || range[2] === "" ? size - 1 : Number(range[2]);

  response.setHeader("Content-Type", replayContentType(served.key));
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-cache");
  if (range !== null && (start < 0 || start > end || end >= size)) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${size}`);

    return response.end();
  }
  if (range !== null) {
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  response.setHeader("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return response.end();
  createReadStream(file, { start, end }).pipe(response);
};

/** The dev server's runner, under /local, and the replays it packs, under /replays. */
export const localRunner = (): Plugin => ({
  name: "effect-browser-local-runner",
  apply: "serve",
  configureServer(server) {
    const web = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(LocalApi).pipe(
        Layer.provide(Runner),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layer]),
      ),
      { disableLogger: true },
    );

    server.httpServer?.once("close", () => void web.dispose());
    server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/replays/") === true) {
        replayFile(request, response, next).then(() => undefined, next);

        return;
      }
      if (request.url?.startsWith("/local/") !== true) return next();
      web.handler(toRequest(request)).then((answer) => send(response, answer), next);
    });
  },
});
