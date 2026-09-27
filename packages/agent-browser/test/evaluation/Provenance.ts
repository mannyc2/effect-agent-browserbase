import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { CampaignRefusal } from "./Campaign.ts";
import { EvidenceError } from "./Evidence.ts";

/**
 * A campaign's audit trail, as the hosted runner keeps one: the source revision is read from a
 * clean checkout, and every file the campaign writes is listed with its digest.
 */

const run = promisify(execFile);

/** The paths the bootstrapped workspace copies from this repository. */
const owned = ["packages/browser", "packages/browserbase", "packages/agent-browser", "lint"];

const refuse = (message: string) => new CampaignRefusal({ reason: "provenance", message });

/**
 * The commit a campaign runs from: `source` must be a clean checkout, and every tracked file it
 * copies into a workspace must be byte-identical in `tree`, the workspace that runs.
 */
export const provenance = Effect.fn("Evaluation.provenance")(function* (
  source: string,
  tree: string,
) {
  const git = (...args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: async () =>
        (await run("git", ["-C", source, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout,
      catch: () => refuse("The source root must be a Git checkout of this repository."),
    });

  const head = (yield* git("rev-parse", "HEAD")).trim();

  if (!/^[a-f0-9]{40}$/.test(head)) return yield* refuse("The source root has no commit.");
  if ((yield* git("status", "--porcelain")).trim() !== "")
    return yield* refuse("The source root has changes no commit names; commit them first.");
  const files = (yield* git("ls-files", "-z", "--", ...owned)).split("\0").filter(Boolean);

  for (const file of files) {
    const same = yield* Effect.promise(async () => {
      try {
        const [expected, actual] = await Promise.all([
          readFile(join(source, file)),
          readFile(join(tree, file)),
        ]);

        return expected.equals(actual);
      } catch {
        return false;
      }
    });

    if (!same)
      return yield* refuse(`The workspace's ${file} is not the source commit's; bootstrap again.`);
  }

  return head;
});

const walk = async (root: string, directory: string): Promise<ReadonlyArray<string>> =>
  (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? walk(root, join(directory, entry.name))
          : Promise.resolve([relative(root, join(directory, entry.name))]),
      ),
    )
  ).flat();

/** `SHA256SUMS` over every file in `directory`, in `sha256sum`'s format, written once. */
export const checksums = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const files = (await walk(directory, directory))
        .filter((file) => file !== "SHA256SUMS")
        .toSorted();

      const lines = await Promise.all(
        files.map(
          async (file) =>
            `${createHash("sha256")
              .update(await readFile(join(directory, file)))
              .digest("hex")}  ${file}`,
        ),
      );

      await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`, { flag: "wx" });
    },
    catch: () => new EvidenceError({ operation: "write campaign checksums" }),
  });
