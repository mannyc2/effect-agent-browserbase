import { expect, it } from "@effect/vitest";

import { inspectExtensionArchive } from "../src/internal/extension/Archive.ts";
import { encodeFilePart } from "../src/internal/http/Multipart.ts";
import { buildZip, extensionArchive } from "./fixtures/Zip.ts";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

it("accepts a bounded extension archive with a root manifest", () => {
  const archive = extensionArchive([
    { name: "background.js", content: "globalThis.ready = true;" },
    { name: "assets/icon.png", content: "png" },
  ]);

  expect(inspectExtensionArchive(archive)).toMatchObject({
    _tag: "Accepted",
    facts: { entries: 3, declaredBytes: 55 + 24 + 3 },
  });
});

it("rejects archives that are not a usable extension before any upload", () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["manifest", buildZip([{ name: "background.js", content: "x" }])],
    ["name", extensionArchive([{ name: "../escape.js", content: "x" }])],
    ["name", extensionArchive([{ name: "/etc/passwd", content: "x" }])],
    ["name", extensionArchive([{ name: "nested\\windows.js", content: "x" }])],
    ["name", extensionArchive([{ name: "deep/../../escape.js", content: "x" }])],
    ["signature", new TextEncoder().encode("not a zip at all, but long enough to inspect")],
    ["malformed", extensionArchive().subarray(0, 20)],
    ["malformed", extensionArchive().subarray(0, 60)],
  ];

  for (const [reason, archive] of cases)
    expect(inspectExtensionArchive(archive)).toMatchObject({ _tag: "Rejected", reason });
});

it("keeps a trailing archive comment inside the record it declares", () => {
  expect(
    inspectExtensionArchive(buildZip([{ name: "manifest.json" }], { comment: "ok" }))._tag,
  ).toBe("Accepted");

  const forged = extensionArchive();
  const truncated = forged.subarray(0, forged.byteLength - 1);

  expect(inspectExtensionArchive(truncated)._tag).toBe("Rejected");
});

it("encodes exactly one file part with a delimiter proven absent from the content", () => {
  const bytes = new TextEncoder().encode("report contents");

  const encoded = encodeFilePart(
    { field: "file", filename: "quarterly report.pdf", mediaType: "application/pdf", bytes },
    1024,
  );

  expect(encoded._tag).toBe("Encoded");
  if (encoded._tag !== "Encoded") return;
  const boundary = encoded.contentType.slice("multipart/form-data; boundary=".length);

  expect(boundary).toMatch(/^effect-agent-browserbase-[0-9a-f]{32}$/);
  expect(decode(encoded.body)).toBe(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="quarterly report.pdf"\r\nContent-Type: application/pdf\r\n\r\nreport contents\r\n--${boundary}--\r\n`,
  );
});

it("refuses parts whose name, type, bounds or delimiter cannot be trusted", () => {
  const bytes = new TextEncoder().encode("x");

  const part = {
    field: "file",
    filename: "extension.zip",
    mediaType: "application/zip",
    bytes,
  } as const;

  const rejections: ReadonlyArray<readonly [string, ReturnType<typeof encodeFilePart>]> = [
    ["configuration", encodeFilePart({ ...part, field: "File" }, 1024)],
    ["configuration", encodeFilePart({ ...part, filename: '"quoted".zip' }, 1024)],
    ["configuration", encodeFilePart({ ...part, filename: "../escape.zip" }, 1024)],
    ["configuration", encodeFilePart({ ...part, filename: "naïve.zip" }, 1024)],
    ["configuration", encodeFilePart({ ...part, mediaType: "application/zip; x=1" }, 1024)],
    ["configuration", encodeFilePart(part, 0)],
    ["limit", encodeFilePart({ ...part, bytes: new Uint8Array(2048) }, 1024)],
  ];

  for (const [reason, result] of rejections)
    expect(result).toMatchObject({ _tag: "Rejected", reason });

  // A delimiter that cannot be separated from the content is refused, never emitted.
  expect(
    encodeFilePart(
      { ...part, bytes: new TextEncoder().encode("prefix-collides-suffix") },
      1024,
      () => "collides",
    ),
  ).toMatchObject({ _tag: "Rejected", reason: "configuration" });
});
