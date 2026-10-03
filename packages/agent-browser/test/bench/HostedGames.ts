import { resolve } from "node:path";

import { Deferred, Effect, Exit, Schema, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { GameSite, PublicOrigins } from "../fixtures/GameSite.ts";

export class HostedGamesError extends Schema.TaggedError<HostedGamesError>()("HostedGamesError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const Options = Schema.Struct({
  executable: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  startupTimeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 60000 })),
});

/** Only the origin announced by a quick tunnel; other log links are ignored. */
export const quickTunnelUrl = (text: string): string | undefined => {
  for (const match of text.matchAll(/https:\/\/[^\s|<>"'`]+/gu)) {
    try {
      const url = new URL(match[0]);

      if (
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/u.test(url.hostname) &&
        url.username === "" &&
        url.password === "" &&
        url.port === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      )
        return url.origin;
    } catch {
      // A log can contain incomplete URLs while its chunks are arriving.
    }
  }

  return undefined;
};

const refuse = (operation: string, message: string, cause?: unknown) =>
  new HostedGamesError({ operation, message, ...(cause === undefined ? {} : { cause }) });

const tunnel = Effect.fnUntraced(function* (
  executable: string,
  localUrl: string,
  host: string,
  startupTimeoutMillis: number,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner
    .spawn(
      ChildProcess.make(
        executable,
        ["tunnel", "--no-autoupdate", "--url", localUrl, "--http-host-header", host],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          extendEnv: true,
          forceKillAfter: "2 seconds",
        },
      ),
    )
    .pipe(
      Effect.mapError((cause) => refuse("start tunnel", "Could not start fixture tunnel.", cause)),
    );

  const ready = yield* Deferred.make<string, HostedGamesError>();
  let tail = "";
  let bytes = 0;
  let announced = false;

  yield* handle.stderr.pipe(
    Stream.mapEffect((chunk) => {
      if (!announced) bytes += chunk.byteLength;

      return bytes <= 65536
        ? Effect.succeed(chunk)
        : Effect.fail(refuse("read tunnel", "Tunnel startup log exceeded 65536 bytes."));
    }),
    Stream.decodeText,
    Stream.runForEach((chunk) => {
      if (announced) return Effect.void;
      const text = tail + chunk;

      // Wait for a token boundary so a hostname split across chunks cannot be accepted early.
      const boundary = Math.max(
        text.lastIndexOf(" "),
        text.lastIndexOf("\n"),
        text.lastIndexOf("|"),
      );

      const url = quickTunnelUrl(text.slice(0, boundary + 1));

      tail = text.slice(-1024);
      if (url === undefined) return Effect.void;
      announced = true;
      tail = "";

      return Deferred.succeed(ready, url).pipe(Effect.asVoid);
    }),
    Effect.catchCause((cause) =>
      Deferred.fail(
        ready,
        refuse("read tunnel", "Could not read fixture tunnel startup.", cause),
      ).pipe(Effect.andThen(handle.kill()), Effect.orDie),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const url = yield* Deferred.await(ready).pipe(
    Effect.raceFirst(
      handle.exitCode.pipe(
        Effect.mapError((cause) =>
          refuse("await tunnel", "Could not await fixture tunnel.", cause),
        ),
        Effect.flatMap((code) =>
          Effect.fail(
            refuse("start tunnel", `Tunnel exited before preparation with code ${code}.`),
          ),
        ),
      ),
    ),
    Effect.timeoutOrElse({
      duration: startupTimeoutMillis,
      orElse: () =>
        Effect.fail(refuse("start tunnel", "Tunnel did not announce an HTTPS origin in time.")),
    }),
  );

  return { url, handle };
});

export interface PreparedHostedGames {
  readonly site: GameSite;
  readonly publicUrls: PublicOrigins;
  readonly originQualification: GameSite["originQualification"];
}

/**
 * Explicit host preparation, before browser navigation. Both children belong to the caller's
 * scope; a partial startup closes them immediately. Distinct origins do not prove PSL sites.
 */
export const prepareHostedGames = Effect.fn("Bench.prepareHostedGames")(function* (
  site: GameSite,
  options: { readonly executable: string; readonly startupTimeoutMillis?: number },
) {
  const config = yield* Schema.decodeEffect(Options)({
    executable: options.executable,
    startupTimeoutMillis: options.startupTimeoutMillis ?? 30000,
  }).pipe(
    Effect.mapError((cause) => refuse("tunnel options", "Invalid fixture tunnel options.", cause)),
  );

  const scope = yield* Effect.acquireRelease(Scope.make("sequential"), (owned, exit) =>
    Scope.close(owned, exit),
  );

  return yield* Effect.gen(function* () {
    const executable = resolve(config.executable);

    const top = yield* tunnel(
      executable,
      site.localUrl,
      new URL(site.localUrl).host,
      config.startupTimeoutMillis,
    );

    const frame = yield* tunnel(
      executable,
      site.localUrl,
      new URL(site.localFrameOrigin).host,
      config.startupTimeoutMillis,
    );

    yield* site
      .setPublicOrigins({ top: top.url, frame: frame.url })
      .pipe(
        Effect.mapError((cause) =>
          refuse("prepare game origins", "Could not prepare game origins.", cause),
        ),
      );

    for (const handle of [top.handle, frame.handle]) {
      const running = yield* handle.isRunning.pipe(
        Effect.mapError((cause) =>
          refuse("check tunnel", "Could not check fixture tunnel.", cause),
        ),
      );

      if (!running)
        return yield* refuse("check tunnel", "Fixture tunnel exited during preparation.");
    }

    return {
      site,
      publicUrls: { top: top.url, frame: frame.url },
      originQualification: site.originQualification,
    } satisfies PreparedHostedGames;
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );
});
