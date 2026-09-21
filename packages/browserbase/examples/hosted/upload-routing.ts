// H6, narrowed: do bytes sent through the session upload API reach the remote browser's file
// chooser intact? A trusted init script gives example.com a file input that renders what it
// was handed; the check compares that against what was uploaded. Large uploads, concurrent
// downloads, certificates and proxies stay open.
import { randomUUID } from "node:crypto";

import * as Bootstrap from "@effect-agent/browserbase/bootstrap";
import { NavigateRequest, ReadTextRequest } from "@effect-agent/browserbase/browser-data";
import { recipe } from "@effect-agent/browserbase/launch";
import { BrowserbaseUploads } from "@effect-agent/browserbase/uploads";
import { Effect } from "effect";

import { hostedCase } from "./harness.ts";

const h = hostedCase("upload-routing");

const content = `effect-agent upload probe ${randomUUID()}\n`;
const bytes = new TextEncoder().encode(content);
const filename = "effect-agent-probe.txt";

const chooser = Bootstrap.init({
  id: "upload-chooser",
  origins: ["https://example.com"],
  content: `document.addEventListener("DOMContentLoaded", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.id = "effect-agent-file";
  const out = document.createElement("pre");
  out.id = "effect-agent-file-out";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    out.textContent = file ? JSON.stringify({ name: file.name, size: file.size, text: await file.text() }) : "none";
  });
  document.body.append(input, out);
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
      yield* session.selectFiles({
        selector: "#effect-agent-file",
        selection: { _tag: "Uploaded", uploads: [receipt] },
      });
      yield* session.waitFor({ selector: "#effect-agent-file-out:not(:empty)", state: "visible" });

      const { text } = yield* session
        .bind()
        .readText(ReadTextRequest.make({ selector: "#effect-agent-file-out" }));

      const seen = JSON.parse(text) as { name: unknown; size: unknown; text: unknown };
      const cleanup = yield* session.close;

      return {
        reference: session.reference,
        remotePath: receipt.remotePath ?? null,
        name: seen.name === filename,
        size: seen.size === bytes.byteLength,
        content: seen.text === content,
        cleanup,
      };
    }).pipe(Effect.provide(h.browser({ launch: recipe(), bootstrap: chooser }))),
  ),
);
