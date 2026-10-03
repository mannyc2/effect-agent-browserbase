import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import {
  HostedGamesError,
  prepareFixtureTunnel,
  prepareHostedGames,
  quickTunnelUrl,
} from "./bench/HostedGames.ts";
import { gameSite } from "./fixtures/GameSite.ts";

type Mode = "ready" | "second-exit" | "second-timeout" | "same-origin" | "flood";

/** Real scoped subprocesses that only emit logs and await termination; no network or browser. */
const scriptedTunnel = Effect.fnUntraced(function* (mode: Mode) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "hosted-games-test-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );

  const executable = join(directory, "scripted-tunnel");

  const source = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = ${JSON.stringify(directory)};
const mode = ${JSON.stringify(mode)};
const counter = join(directory, "counter");
const index = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(index));
appendFileSync(join(directory, "started"), JSON.stringify({ index, pid:process.pid, args:process.argv.slice(2), inheritedSecret: process.env.BENCH_TUNNEL_TEST_SECRET !== undefined }) + "\n");
process.on("SIGTERM", () => {
  appendFileSync(join(directory, "stopped"), String(index) + "\n");
  process.exit(0);
});
if (mode === "second-exit" && index === 2) process.exit(7);
if (mode === "flood") process.stderr.write("x".repeat(70000));
else if (!(mode === "second-timeout" && index === 2)) {
  const label = mode === "same-origin" || index === 1 ? "lobby" : "frame";
  process.stderr.write("INFO https://developers.cloudflare.com/cloudflare-one/\n");
  process.stderr.write("| https://" + label + "-scripted.trycloudflare.");
  setTimeout(() => process.stderr.write("com |\n"), 5);
}
setInterval(() => {}, 1000);
`;

  yield* Effect.promise(() => writeFile(executable, source, { mode: 0o700 }));

  return {
    executable,
    started: () =>
      Effect.promise(async () =>
        (await readFile(join(directory, "started"), "utf8"))
          .trim()
          .split("\n")
          .map((line) =>
            Schema.decodeUnknownSync(
              Schema.Struct({
                index: Schema.Int,
                pid: Schema.Int,
                args: Schema.Array(Schema.String),
                inheritedSecret: Schema.Boolean,
              }),
            )(JSON.parse(line)),
          ),
      ),
    stopped: () =>
      Effect.promise(async () => {
        try {
          return (await readFile(join(directory, "stopped"), "utf8"))
            .trim()
            .split("\n")
            .map(Number)
            .sort((a, b) => a - b);
        } catch {
          return [];
        }
      }),
  };
});

it("quick tunnel origins ignore documentation links and malformed or decorated URLs", () => {
  expect(
    quickTunnelUrl(
      "INFO docs https://developers.cloudflare.com/ | https://sample-lobby.trycloudflare.com |",
    ),
  ).toBe("https://sample-lobby.trycloudflare.com");
  for (const url of [
    "http://sample.trycloudflare.com",
    "https://sample.trycloudflare.com.evil.example",
    "https://user@sample.trycloudflare.com",
    "https://sample.trycloudflare.com:8443",
    "https://sample.trycloudflare.com/path",
    "https://sample.trycloudflare.com?token=hidden",
    "https://sample.trycloudflare.com#fragment",
    "https://-sample.trycloudflare.com",
    "https://sample.trycloudflare.",
  ])
    expect(quickTunnelUrl(url)).toBeUndefined();
});

it.live("single-fixture preparation owns one child and forwards the exact loopback host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const script = yield* scriptedTunnel("ready");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* prepareFixtureTunnel("http://127.0.0.1:3210", {
            executable: script.executable,
            startupTimeoutMillis: 2000,
          });

          expect(prepared.url).toBe("https://lobby-scripted.trycloudflare.com");
          expect(yield* script.started()).toMatchObject([
            {
              args: [
                "tunnel",
                "--no-autoupdate",
                "--url",
                "http://127.0.0.1:3210",
                "--http-host-header",
                "127.0.0.1:3210",
              ],
            },
          ]);
          expect(yield* script.stopped()).toEqual([]);
        }),
      );
      expect(yield* script.stopped()).toEqual([1]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("fixture children do not inherit unrelated host credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.BENCH_TUNNEL_TEST_SECRET;

          process.env.BENCH_TUNNEL_TEST_SECRET = "synthetic-secret";

          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.BENCH_TUNNEL_TEST_SECRET;
            else process.env.BENCH_TUNNEL_TEST_SECRET = previous;
          }),
      );
      const script = yield* scriptedTunnel("ready");

      yield* prepareFixtureTunnel("http://127.0.0.1:3210", {
        executable: script.executable,
        startupTimeoutMillis: 2000,
      });
      expect((yield* script.started()).map((child) => child.inheritedSecret)).toEqual([false]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("single-fixture preparation refuses decorated or remote URLs before starting a child", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const script = yield* scriptedTunnel("ready");
      const fs = yield* FileSystem.FileSystem;

      for (const localUrl of [
        "https://127.0.0.1:3210",
        "http://example.com",
        "http://user@localhost:3210",
        "http://localhost:3210/path",
        "http://localhost:3210?query=value",
        "http://localhost:3210#fragment",
        "malformed",
      ]) {
        const result = yield* prepareFixtureTunnel(localUrl, {
          executable: script.executable,
        }).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Schema.is(HostedGamesError)(result.failure)).toBe(true);
      }
      expect(yield* fs.exists(join(dirname(script.executable), "started"))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "preparation preserves the exact ledger and closes both children while the local server remains owned",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const script = yield* scriptedTunnel("ready");
        const site = yield* gameSite({ seed: 5 });
        const originalEvents = site.events;
        const originalState = site.state;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const prepared = yield* prepareHostedGames(site, {
              executable: script.executable,
              startupTimeoutMillis: 2000,
            });

            expect(prepared.site).toBe(site);
            expect(site.events).toBe(originalEvents);
            expect(site.state).toBe(originalState);
            expect(prepared.publicUrls).toEqual({
              top: "https://lobby-scripted.trycloudflare.com",
              frame: "https://frame-scripted.trycloudflare.com",
            });
            expect(prepared.originQualification).toBe(
              "configured-cross-origin-operator-site-prepared",
            );
            expect(site.url).toBe(`${prepared.publicUrls.top}/`);
            expect(site.frameOrigin).toBe(prepared.publicUrls.frame);

            const response = yield* Effect.promise(() =>
              fetch(`${site.localUrl}play/reels`, {
                headers: { cookie: "fixtureConsent=yes; fixtureAdult=yes" },
              }),
            );

            expect(yield* Effect.promise(() => response.text())).toContain(
              `src="${prepared.publicUrls.frame}/frame/reels?seed=5&credits=1000"`,
            );

            const truth = yield* Effect.promise(() =>
              fetch(`${site.localUrl}truth`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  kind: "reels",
                  sequence: 1,
                  event: { tag: "ready", spin: 0, atMillis: 0 },
                }),
              }),
            );

            expect(truth.status).toBe(204);
            expect(site.state("reels").ready).toBe(true);
            expect(site.events()).toHaveLength(1);
            expect(yield* script.stopped()).toEqual([]);
            const children = yield* script.started();

            expect(children).toHaveLength(2);
            for (const child of children) {
              expect(child.args.slice(0, 4)).toEqual([
                "tunnel",
                "--no-autoupdate",
                "--url",
                site.localUrl,
              ]);
              expect(child.args.slice(4)).toEqual([
                "--http-host-header",
                new URL(child.index === 1 ? site.localUrl : site.localFrameOrigin).host,
              ]);
            }
          }),
        );
        expect(yield* script.stopped()).toEqual([1, 2]);
        expect((yield* Effect.promise(() => fetch(site.localUrl))).status).toBe(200);
        expect(site.events()).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const mode of ["second-exit", "second-timeout", "same-origin", "flood"] as const)
  it.live(`partial ${mode} preparation closes every live child before returning failure`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const script = yield* scriptedTunnel(mode);
        const site = yield* gameSite();

        const result = yield* prepareHostedGames(site, {
          executable: script.executable,
          startupTimeoutMillis: mode === "second-timeout" ? 150 : 2000,
        }).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Schema.is(HostedGamesError)(result.failure)).toBe(true);
        expect(site.url).toBe(site.localUrl);
        expect(site.events()).toEqual([]);
        const expected = mode === "second-exit" || mode === "flood" ? [1] : [1, 2];

        expect(yield* script.stopped()).toEqual(expected);
        expect((yield* Effect.promise(() => fetch(site.localUrl))).status).toBe(200);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
