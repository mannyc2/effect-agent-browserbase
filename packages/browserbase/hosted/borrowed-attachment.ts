// H4, narrowed: a separate process borrows a detached session and leaves release to its owner.
// Duplicate registrations, retired callbacks and a borrower that outlives the owner stay open.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import { ClickRequest, NavigateRequest, ReadTextRequest } from "effect-browser/browser-data";
import { recipe } from "effect-browserbase/launch";
import { SessionReference } from "effect-browserbase/references";

import { hostedCase } from "./harness.ts";

const h = hostedCase("borrowed-attachment");
const origin = "https://example.com";

const counter = Bootstrap.init({
  id: "borrow-counter",
  origins: [origin],
  content: `document.addEventListener("DOMContentLoaded", () => {
  const button = document.createElement("button");
  button.id = "effect-agent-increment";
  button.textContent = "Increment";
  const count = document.createElement("output");
  count.id = "effect-agent-count";
  count.textContent = "0";
  button.addEventListener("click", () => { count.textContent = String(Number(count.textContent) + 1); });
  document.body.append(button, count);
});`,
});

const Borrowed = Schema.fromJsonString(
  Schema.Struct({
    check: Schema.Literal("borrowed-attachment"),
    phase: Schema.Literal("borrowed"),
    result: Schema.Struct({
      pid: Schema.Int,
      before: Schema.String,
      after: Schema.String,
      cleanup: Schema.Struct({
        ownership: Schema.String,
        remote: Schema.String,
        releaseRequested: Schema.Boolean,
        local: Schema.String,
      }),
    }),
  }),
);

const runBorrower = (reference: SessionReference, targetId: string) =>
  Effect.callback<
    typeof Borrowed.Type.result,
    { readonly _tag: "BorrowerEnded"; readonly code: number | null }
  >((resume) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "borrower", JSON.stringify(reference), targetId],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    const lines = createInterface({ input: child.stdout });
    let borrowed: typeof Borrowed.Type.result | undefined;
    let closed = false;

    lines.on("line", (line) => {
      console.log(line);
      const decoded = Schema.decodeOption(Borrowed)(line);

      if (decoded._tag === "Some") borrowed = decoded.value.result;
    });
    child.once("error", () => resume(Effect.fail({ _tag: "BorrowerEnded", code: null })));
    child.once("close", (code) => {
      closed = true;
      resume(
        code === 0 && borrowed !== undefined
          ? Effect.succeed(borrowed)
          : Effect.fail({ _tag: "BorrowerEnded", code }),
      );
    });

    // Join termination before the owning browser can release, including on timeout.
    return Effect.callback<void>((joined) => {
      lines.close();
      if (closed) {
        joined(Effect.void);
      } else {
        child.once("close", () => joined(Effect.void));
        child.kill("SIGKILL");
      }
    }).pipe(Effect.timeout(5000), Effect.orDie);
  }).pipe(Effect.timeout(60_000));

const parent = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open({ bootstrap: counter });

    yield* session.initialPage.navigate(NavigateRequest.make({ url: `${origin}/` }));
    yield* session.initialPage.waitFor({ selector: "#effect-agent-count", state: "attached" });
    const detached = yield* session.detach;

    yield* h.report("detached", { targetId: detached.targetId });
    const borrowed = yield* runBorrower(session.reference, detached.targetId);
    const inventory = yield* session.reconnect(true);
    const selected = inventory.pages.find((page) => page.targetId === detached.targetId);

    if (selected === undefined) return yield* Effect.die("Reconnected page missing");
    const page = yield* session.page(selected);
    const count = yield* page.readText(ReadTextRequest.make({ selector: "#effect-agent-count" }));
    const cleanup = yield* session.closeChecked;

    yield* h.established({
      "the borrower ran in another process": borrowed.pid !== process.pid,
      "the borrower saw the owner's page": borrowed.before === "0",
      "the borrower changed it": borrowed.after === "1",
      "the borrower did not release":
        borrowed.cleanup.ownership === "borrowed" &&
        borrowed.cleanup.remote === "not-owned" &&
        borrowed.cleanup.releaseRequested === false &&
        borrowed.cleanup.local === "closed",
      "the owner reconnected to the same page": selected.targetId === detached.targetId,
      "the owner sees the borrower's change": count.text === "1",
      "the owner released": cleanup.ownership === "owned" && cleanup.remote === "confirmed",
    });

    return {
      borrowed,
      sameTarget: selected.targetId === detached.targetId,
      count: count.text,
      cleanup,
    };
  }).pipe(Effect.provide(h.browser({ launch: recipe({ keepAlive: true }) }))),
);

const borrower = Effect.fnUntraced(function* (reference: SessionReference, targetId: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.borrow(reference, { target: { targetId } });
      const page = session.initialPage;

      const before = yield* page.readText(
        ReadTextRequest.make({ selector: "#effect-agent-count" }),
      );

      yield* page.click(ClickRequest.make({ selector: "#effect-agent-increment" }));
      const after = yield* page.readText(ReadTextRequest.make({ selector: "#effect-agent-count" }));
      const cleanup = yield* session.closeChecked;

      const result = {
        pid: process.pid,
        before: before.text,
        after: after.text,
        cleanup: {
          ownership: cleanup.ownership,
          remote: cleanup.remote,
          releaseRequested: cleanup.releaseRequested,
          local: cleanup.local,
        },
      };

      yield* h.report("borrowed", result);

      return result;
    }).pipe(Effect.provide(h.browser({ launch: recipe() }))),
  );
});

const [role, encodedReference, targetId] = process.argv.slice(2);

if (role === "borrower" && encodedReference !== undefined && targetId !== undefined) {
  await h.run(
    Schema.decodeEffect(Schema.fromJsonString(SessionReference))(encodedReference).pipe(
      Effect.flatMap((reference) => borrower(reference, targetId)),
    ),
  );
} else if (role === undefined) {
  await h.run(parent);
} else {
  throw new Error("Expected borrower, session reference and target identifier");
}
