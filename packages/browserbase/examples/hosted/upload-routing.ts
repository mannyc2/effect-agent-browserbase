// H6, narrowed: do bytes sent through the session upload API reach the remote browser's file
// chooser intact? A trusted init script gives example.com file inputs that render what they
// were handed; the check compares that against what was uploaded. Large uploads, concurrent
// downloads, certificates and proxies stay open.
import { randomUUID } from "node:crypto";

import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { NavigateRequest, ReadTextRequest } from "@effect-agent/browserbase/browser-data";
import { recipe } from "@effect-agent/browserbase/launch";
import { BrowserbaseUploads } from "@effect-agent/browserbase/uploads";
import { Clock, Effect } from "effect";

import { hostedCase } from "./harness.ts";

const h = hostedCase("upload-routing");

const content = `effect-agent upload probe ${randomUUID()}\n`;
const bytes = new TextEncoder().encode(content);
const filename = "effect-agent-probe.txt";

// The provider acknowledges an upload before the browser can necessarily open it, so the file
// is selected into a fresh input at each of these delays after the acknowledgement. A fresh
// input matters: selecting the same file into the same input again fires no change event.
const delaysMillis = [0, 5_000, 15_000, 30_000, 60_000];

interface Seen {
  readonly name: unknown;
  readonly size: unknown;
  readonly text: unknown;
  readonly error: unknown;
}

const chooser = Bootstrap.init({
  id: "upload-chooser",
  origins: ["https://example.com"],
  content: `document.addEventListener("DOMContentLoaded", () => {
  for (let index = 0; index < ${delaysMillis.length}; index++) {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "effect-agent-file-" + index;
    const out = document.createElement("pre");
    out.id = "effect-agent-file-out-" + index;
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return void (out.textContent = "none");
      let text = null;
      let error = null;
      try {
        text = await file.text();
      } catch (cause) {
        error = String(cause && cause.name);
      }
      out.textContent = JSON.stringify({ name: file.name, size: file.size, text, error });
    });
    document.body.append(input, out);
  }
});`,
});

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open;

      yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com/" }));

      const receipt = yield* (yield* BrowserbaseUploads).create(session.reference, {
        filename,
        mediaType: "text/plain",
        bytes,
        maxBytes: h.budget.transferBytes,
      });

      yield* h.report("uploaded", receipt);
      const uploadedAt = yield* Clock.currentTimeMillis;
      const attempts: Array<{ readonly afterMillis: number; readonly seen: Seen | null }> = [];

      for (const [index, delay] of delaysMillis.entries()) {
        const elapsed = (yield* Clock.currentTimeMillis) - uploadedAt;

        yield* Effect.sleep(Math.max(0, delay - elapsed));
        const afterMillis = (yield* Clock.currentTimeMillis) - uploadedAt;

        yield* session.selectFiles({
          selector: `#effect-agent-file-${index}`,
          selection: { _tag: "Uploaded", uploads: [receipt] },
        });
        yield* Effect.sleep(1_000);

        const { text } = yield* session
          .bind()
          .readText(ReadTextRequest.make({ selector: `#effect-agent-file-out-${index}` }));

        const seen = text === "" ? null : (JSON.parse(text) as Seen);

        attempts.push({ afterMillis, seen });
        if (seen !== null && seen.error === null) break;
      }
      const cleanup = yield* session.close;
      const seen = attempts.at(-1)?.seen ?? null;

      const observed = attempts.map((attempt) => ({
        afterMillis: attempt.afterMillis,
        size: attempt.seen?.size ?? null,
        error: attempt.seen?.error ?? null,
      }));

      yield* h
        .established({
          name: seen?.name === filename,
          size: seen?.size === bytes.byteLength,
          content: seen?.text === content,
        })
        .pipe(Effect.tapError(() => h.report("observed", observed)));

      return { reference: session.reference, remotePath: receipt.remotePath, observed, cleanup };
    }).pipe(Effect.provide(h.browser({ launch: recipe(), bootstrap: chooser }))),
  ),
);
