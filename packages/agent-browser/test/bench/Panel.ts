import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { Effect, Schema } from "effect";

export const Arm = Schema.Literals(["human", "plain", "performed", "tuned"]);
export type Arm = typeof Arm.Type;
const ClipId = Schema.String.check(Schema.isPattern(/^clip-\d{3}$/));

export const PanelClip = Schema.Struct({
  id: ClipId,
  arm: Arm,
  file: Schema.String.check(Schema.isPattern(/^clips\/clip-\d{3}\.mp4$/)),
  sha256: Schema.String,
});

export type PanelClip = typeof PanelClip.Type;

export const PanelManifest = Schema.Struct({
  version: Schema.Literal(1),
  seed: Schema.Int,
  clips: Schema.Array(PanelClip).check(Schema.isMinLength(1), Schema.isMaxLength(120)),
});

export type PanelManifest = typeof PanelManifest.Type;

export const Rating = Schema.Struct({
  rater: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  clipId: ClipId,
  guess: Schema.Literals(["person", "bot"]),
  naturalness: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  atMillis: Schema.Finite,
});

export type Rating = typeof Rating.Type;
const Ratings = Schema.Array(Rating).check(Schema.isMaxLength(15360));

export class PanelError extends Schema.TaggedError<PanelError>()("BenchPanelError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Fisher-Yates with an explicit seed; names and presentation order disclose no source arm. */
export const shuffled = <A>(items: ReadonlyArray<A>, seed: number): ReadonlyArray<A> => {
  const output = [...items];
  let value = seed >>> 0 || 0x9e3779b9;

  for (let index = output.length - 1; index > 0; index--) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const other = (value >>> 0) % (index + 1);
    const item = output[index];
    const replacement = output[other];

    if (item !== undefined && replacement !== undefined) {
      output[index] = replacement;
      output[other] = item;
    }
  }

  return output;
};

export const preparePanel = Effect.fn("Bench.preparePanel")(function* (input: {
  readonly outputDirectory: string;
  readonly seed: number;
  readonly clips: ReadonlyArray<{ readonly arm: Arm; readonly path: string }>;
}) {
  const config = yield* Schema.decodeEffect(
    Schema.Struct({
      outputDirectory: Schema.NonEmptyString,
      seed: Schema.Int,
      clips: Schema.Array(Schema.Struct({ arm: Arm, path: Schema.NonEmptyString })).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(120),
      ),
    }),
  )(input);

  return yield* Effect.tryPromise({
    try: async () => {
      const directory = resolve(config.outputDirectory);

      await mkdir(directory);
      await mkdir(join(directory, "clips"));
      const clips: PanelClip[] = [];

      for (const [index, clip] of shuffled(config.clips, config.seed).entries()) {
        const size = await stat(clip.path);

        if (!size.isFile() || size.size < 1 || size.size > 128 * 1024 * 1024)
          throw new Error("Clip file bound exceeded");
        const id = `clip-${String(index + 1).padStart(3, "0")}`;
        const file = `clips/${id}.mp4`;

        await copyFile(clip.path, join(directory, file));

        const sha256 = createHash("sha256")
          .update(await readFile(join(directory, file)))
          .digest("hex");

        clips.push({ id, arm: clip.arm, file, sha256 });
      }
      const manifest: PanelManifest = { version: 1, seed: config.seed, clips };

      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
        flag: "wx",
      });
      await writeFile(join(directory, "ratings.json"), "[]\n", { flag: "wx" });

      return { directory, manifest };
    },
    catch: (cause) =>
      new PanelError({
        operation: "prepare",
        message: "Panel needs bounded clips and a new output directory.",
        cause,
      }),
  });
});

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((total, value) => total + value, 0) / values.length;

/** Raters, rather than correlated clip answers, are the independent units of the interval. */
const interval = (values: ReadonlyArray<number>, minimum: number, maximum: number) => {
  if (values.length < 2) return null;
  const average = mean(values);

  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);

  const critical =
    [
      0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16,
      2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052,
      2.048, 2.045, 2.042,
    ][Math.min(30, values.length - 1)] ?? 2.042;

  const radius = critical * Math.sqrt(variance / values.length);

  return {
    low: Math.max(minimum, average - radius),
    high: Math.min(maximum, average + radius),
    level: 0.95,
    method: "t interval over independent rater means",
  };
};

export const panelReport = (manifestInput: PanelManifest, ratingsInput: ReadonlyArray<Rating>) => {
  const manifest = Schema.decodeSync(PanelManifest)(manifestInput);
  const ratings = Schema.decodeSync(Ratings)(ratingsInput);
  const known = new Map(manifest.clips.map((clip) => [clip.id, clip.arm]));
  const unique = new Map<string, Rating>();

  for (const rating of ratings) {
    if (!known.has(rating.clipId)) throw new Error("Rating names an unknown clip");
    const key = `${rating.rater}:${rating.clipId}`;

    if (unique.has(key)) throw new Error("Duplicate rater and clip rating");
    unique.set(key, rating);
  }

  return (["human", "plain", "performed", "tuned"] as const).map((arm) => {
    const rows = [...unique.values()].filter((rating) => known.get(rating.clipId) === arm);
    const raters = [...new Set(rows.map((rating) => rating.rater))];
    const groups = raters.map((rater) => rows.filter((rating) => rating.rater === rater));

    const fooled = groups.map((group) =>
      mean(group.map((rating) => (rating.guess === "person" ? 1 : 0))),
    );

    const naturalness = groups.map((group) => mean(group.map((rating) => rating.naturalness)));

    return {
      arm,
      clips: manifest.clips.filter((clip) => clip.arm === arm).length,
      raters: raters.length,
      ratings: rows.length,
      personRate: fooled.length === 0 ? null : mean(fooled),
      fooledRate: arm === "human" || fooled.length === 0 ? null : mean(fooled),
      personRateInterval: interval(fooled, 0, 1),
      meanNaturalness: naturalness.length === 0 ? null : mean(naturalness),
      naturalnessInterval: interval(naturalness, 1, 5),
      interpretation: arm === "human" ? "human recognition control" : "fooled rate",
      completion:
        rows.length === 0
          ? "awaiting ratings"
          : rows.length === raters.length * manifest.clips.filter((clip) => clip.arm === arm).length
            ? "complete for participating raters"
            : "partial ratings",
    };
  });
};

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Browsing clips</title>
<style>body{margin:2rem auto;max-width:70rem;background:#101722;color:#eef2f7;font:18px system-ui}video{width:100%;background:black}button,select{font:inherit;padding:.6rem;margin:.5rem}fieldset{margin:1rem 0}#status{min-height:2rem}</style>
<h1>Browsing clips</h1><p>Watch each clip, then give your first impression. There are no right answers.</p>
<video id="video" controls playsinline loop></video><p id="progress"></p>
<form id="rating"><fieldset><legend>Person or bot?</legend><label><input type="radio" name="guess" value="person" required> Person</label> <label><input type="radio" name="guess" value="bot" required> Bot</label></fieldset>
<label>How natural, 1–5? <select name="naturalness" required><option value="">Choose</option><option value="1">1 — very mechanical</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5 — very natural</option></select></label>
<button>Save and continue</button></form><p id="status"></p>
<script>let clips=[],index=0;const video=document.querySelector('#video'),form=document.querySelector('#rating'),status=document.querySelector('#status');
const show=()=>{if(index>=clips.length){video.hidden=true;form.hidden=true;status.textContent='Thank you. Your answers are saved.';return;}video.src=clips[index].url;document.querySelector('#progress').textContent='Clip '+(index+1)+' of '+clips.length;form.reset();};
fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(response=>{if(!response.ok)throw Error('Could not start rating session');return response.json();}).then(data=>{clips=data.clips;show();}).catch(error=>status.textContent=error.message);
form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const values=new FormData(form);const response=await fetch('/api/rating',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clipId:clips[index].id,guess:values.get('guess'),naturalness:Number(values.get('naturalness'))})});if(!response.ok)throw Error('We could not confirm this answer. Reload to see which clips remain.');status.textContent='';index++;show();}catch(error){status.textContent=error.message;}finally{button.disabled=false;}});</script>`;

const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    bytes += buffer.length;
    if (bytes > 4096) throw new Error("Rating request bound exceeded");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const readPanel = async (directory: string) => {
  const manifestPath = join(directory, "manifest.json");
  const ratingsPath = join(directory, "ratings.json");
  const [manifestSize, ratingSize] = await Promise.all([stat(manifestPath), stat(ratingsPath)]);

  if (manifestSize.size > 1024 * 1024 || ratingSize.size > 4 * 1024 * 1024)
    throw new Error("Panel file byte bound exceeded");

  const [manifestText, ratingText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(ratingsPath, "utf8"),
  ]);

  return {
    manifest: Schema.decodeUnknownSync(PanelManifest)(JSON.parse(manifestText)),
    ratings: Schema.decodeUnknownSync(Ratings)(JSON.parse(ratingText)),
  };
};

/** Only anonymous clip URLs and the current participant's clip IDs leave this scoped server. */
export const servePanel = Effect.fn("Bench.servePanel")(function* (options: {
  readonly directory: string;
  readonly port?: number;
}) {
  const config = yield* Schema.decodeEffect(
    Schema.Struct({
      directory: Schema.NonEmptyString,
      port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 32767 })),
    }),
  )({ directory: options.directory, port: options.port ?? 0 });

  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const directory = resolve(config.directory);

        const loaded = await readPanel(directory);
        const manifest = loaded.manifest;
        const ratings = [...loaded.ratings];

        const raters = new Set(ratings.map((rating) => rating.rater));
        const pending = new Set<string>();
        let write = Promise.resolve();

        const respond = (response: ServerResponse, status: number, value: unknown) => {
          response.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify(value));
        };

        const handle = async (request: IncomingMessage, response: ServerResponse) => {
          const url = new URL(request.url ?? "/", "http://panel.test");

          const rater = request.headers.cookie
            ?.split(";")
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith("panelRater="))
            ?.slice(11);

          if (url.pathname === "/" && request.method === "GET") {
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            });
            response.end(page);

            return;
          }
          if (url.pathname === "/api/session" && request.method === "POST") {
            if (raters.size >= 128 && (rater === undefined || !raters.has(rater)))
              return respond(response, 409, { error: "Panel participant bound reached" });
            const identity = rater !== undefined && raters.has(rater) ? rater : randomUUID();

            raters.add(identity);
            const hash = createHash("sha256").update(identity).digest().readUInt32LE(0);

            const completed = new Set(
              ratings.filter((rating) => rating.rater === identity).map((rating) => rating.clipId),
            );

            response.setHeader(
              "set-cookie",
              `panelRater=${identity}; Path=/; HttpOnly; SameSite=Strict`,
            );
            respond(response, 200, {
              clips: shuffled(manifest.clips, manifest.seed ^ hash)
                .filter((clip) => !completed.has(clip.id))
                .map((clip) => ({ id: clip.id, url: `/clip/${clip.id}` })),
            });

            return;
          }
          if (url.pathname === "/api/rating" && request.method === "POST") {
            if (rater === undefined || !raters.has(rater))
              return respond(response, 401, { error: "Start a rating session first" });
            if (!request.headers["content-type"]?.startsWith("application/json"))
              return respond(response, 415, { error: "JSON required" });

            const input = Schema.decodeUnknownSync(
              Schema.Struct({
                clipId: ClipId,
                guess: Schema.Literals(["person", "bot"]),
                naturalness: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
              }),
            )(await readJson(request));

            if (
              !manifest.clips.some((clip) => clip.id === input.clipId) ||
              ratings.some((rating) => rating.rater === rater && rating.clipId === input.clipId) ||
              pending.has(`${rater}:${input.clipId}`)
            )
              return respond(response, 409, { error: "Unknown or already rated clip" });
            const key = `${rater}:${input.clipId}`;
            const rating: Rating = { ...input, rater, atMillis: Date.now() };

            pending.add(key);

            const transaction = write
              .then(async () => {
                await writeFile(
                  join(directory, "ratings.pending.json"),
                  JSON.stringify([...ratings, rating], null, 2),
                );
                await rename(
                  join(directory, "ratings.pending.json"),
                  join(directory, "ratings.json"),
                );
                ratings.push(rating);
              })
              .finally(() => {
                pending.delete(key);
              });

            // The requesting task retains failure; this tail lets later, independent ratings proceed.
            write = transaction.catch(() => undefined);
            await transaction;
            respond(response, 200, { saved: true });

            return;
          }
          if (url.pathname.startsWith("/clip/") && request.method === "GET") {
            const clip = manifest.clips.find((entry) => url.pathname === `/clip/${entry.id}`);

            if (clip === undefined) return respond(response, 404, { error: "Clip not found" });
            const file = join(directory, clip.file);
            const size = await stat(file);
            const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const start = range === undefined || range === null ? 0 : Number(range[1]);

            const end =
              range === undefined || range === null || range[2] === ""
                ? size.size - 1
                : Math.min(size.size - 1, Number(range[2]));

            if (start > end || start < 0 || end >= size.size)
              return respond(response, 416, { error: "Range unavailable" });
            response.writeHead(range === undefined || range === null ? 200 : 206, {
              "content-type": "video/mp4",
              "content-length": end - start + 1,
              "accept-ranges": "bytes",
              ...(range === undefined || range === null
                ? {}
                : { "content-range": `bytes ${start}-${end}/${size.size}` }),
            });
            createReadStream(file, { start, end })
              .on("error", () => response.destroy())
              .pipe(response);

            return;
          }
          respond(response, 404, { error: "Page not found" });
        };

        const server = createServer((request, response) => {
          void handle(request, response).catch(() =>
            respond(response, 400, { error: "Invalid panel request" }),
          );
        });

        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(config.port, "127.0.0.1", resolve);
        });
        const address = server.address();

        if (address === null || typeof address === "string")
          throw new Error("No panel server port");

        return {
          port: address.port,
          url: `http://127.0.0.1:${address.port}/`,
          close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
            await write;
          },
        };
      },
      catch: (cause) =>
        new PanelError({
          operation: "serve",
          message: "Cannot load and serve the private panel directory.",
          cause,
        }),
    }),
    (server) => Effect.promise(server.close),
  );
});

export const loadPanelReport = Effect.fn("Bench.loadPanelReport")(function* (directory: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const data = await readPanel(directory);

      return panelReport(data.manifest, data.ratings);
    },
    catch: (cause) =>
      new PanelError({
        operation: "report",
        message: "Cannot read validated panel results.",
        cause,
      }),
  });
});
