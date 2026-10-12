// Puts a packed replay in the deployed site's R2 bucket: every file under public/replays/<id>/,
// keyed `<id>/<file>`, with its content type. It decodes replay.json first, so a replay the player
// cannot read is never published.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun run upload -- polymarket
//
// The token needs R2 write access. The bucket is the one alchemy.run.ts names.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { argv, env, exit } from "node:process";

import { Schema } from "effect";

import { Replay } from "./src/replay.ts";
import { isReplayId, replayContentType } from "./src/serve.ts";

const bucket = "effect-browser-replays";

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const main = async () => {
  const id = argv[2];
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;

  if (id === undefined || !isReplayId(id)) throw new Error("Usage: bun run upload -- <replay id>");
  if (account === undefined || token === undefined)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (R2 write access).");
  const dir = join(import.meta.dirname, "public", "replays", id);

  Schema.decodeUnknownSync(Replay)(JSON.parse(await readFile(join(dir, "replay.json"), "utf8")));

  for (const file of await filesUnder(dir)) {
    const key = `${id}/${relative(dir, file).split("\\").join("/")}`;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/${key}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": replayContentType(key) },
        body: await readFile(file),
      },
    );

    if (!response.ok) throw new Error(`${key}: R2 answered ${response.status}`);
    console.log(`uploaded ${key}`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  exit(1);
});
