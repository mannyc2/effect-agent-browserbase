import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { SessionReference } from "effect-browserbase/references";

// Type-only, so nothing runs here; it keeps the child program beside this suite wherever the
// suite is staged, including the packed-consumer run.
import type {} from "../fixtures/HandoffChild.ts";
import {
  localBrowser,
  NativeFixtureError,
  policy,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

const ChildResult = Schema.Struct({
  pid: Schema.Finite,
  heading: Schema.String,
  count: Schema.String,
  cleanup: Schema.Struct({
    ownership: Schema.String,
    remote: Schema.String,
    releaseRequested: Schema.Boolean,
    local: Schema.String,
  }),
});

const child = fileURLToPath(new URL("../fixtures/HandoffChild.ts", import.meta.url));

/** Starts a fresh runtime process and returns its one JSON line, or fails with its output. */
const runChild = (handoff: {
  readonly reference: SessionReference;
  readonly targetId: string;
  readonly providerBridge: string;
  readonly endpoint: string;
}) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const started = spawn(process.env.BROWSERBASE_HANDOFF_RUNTIME ?? "bun", [child], {
          env: { ...process.env, BROWSERBASE_HANDOFF: JSON.stringify(handoff) },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => started.kill("SIGKILL"), 60_000);

        started.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        started.stderr.on(
          "data",
          (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-8192)),
        );
        started.once("error", reject);
        started.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(stdout.trim().split("\n").at(-1) ?? "");
          else reject(new Error(`handoff child exited ${code}: ${stderr}`));
        });
      }),
    catch: (cause) => NativeFixtureError.make({ operation: "run handoff child", cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ChildResult))));

it.live(
  "real CDP: a freshly started process attaches by durable reference and leaves release to the owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const owner = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* owner.navigate(NavigateRequest.make({ url: fixture.url }));
            const selected = (yield* owner.pages).find((page) => page.selected);
            const endpoint = fixture.sessions.get(owner.reference.sessionId)?.endpoint;

            expect(selected).toBeDefined();
            expect(endpoint).toBeDefined();

            const borrowed = yield* runChild({
              reference: owner.reference,
              targetId: selected!.targetId,
              providerBridge: fixture.url,
              endpoint: endpoint!,
            });

            // A different operating-system process drove the same live page.
            expect(borrowed.pid).not.toBe(process.pid);
            expect(borrowed.heading).toBe("Local browser fixture");
            expect(borrowed.count).toBe("1");
            expect(borrowed.cleanup).toEqual({
              ownership: "borrowed",
              remote: "not-owned",
              releaseRequested: false,
              local: "closed",
            });
            // The borrower's close sent no release, so the owner's session is still running.
            expect(fixture.releaseIds).toEqual([]);
            expect(fixture.sessions.get(owner.reference.sessionId)?.status).toBe("RUNNING");

            // The owner still drives the page the other process changed.
            const count = yield* owner.readText(ReadTextRequest.make({ selector: "#count" }));

            expect(count.text).toBe("1");
            const report = yield* owner.close;

            expect(report.ownership).toBe("owned");
            expect(report.releaseRequested).toBe(true);
          }),
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
        // Only the owner connected through this process's binding; the child used its own.
        expect(fixture.connections).toEqual(["session-1"]);
      }),
    ),
);
