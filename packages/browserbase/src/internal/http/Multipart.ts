import { Effect, Random, Schema } from "effect";

import type { MultipartFile } from "../../Client.ts";
import { SafeFilename } from "../../Transfers.ts";

/** One file part is the only multipart shape this transport produces. */
export type MultipartResult =
  | {
      readonly _tag: "Encoded";
      readonly contentType: string;
      readonly body: Uint8Array;
    }
  | { readonly _tag: "Rejected"; readonly reason: "configuration" | "limit" };

const FIELD = /^[a-z][a-z0-9_]{0,31}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_+.-]{0,63}\/[a-z0-9][a-z0-9!#$&^_+.-]{0,63}$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

const isSafeFilename = Schema.is(SafeFilename);

/** Quoting is only safe for a portable, printable, quote-free basename. */
const quotable = (value: string): boolean =>
  isSafeFilename(value) && PRINTABLE_ASCII.test(value) && !value.includes('"');

/**
 * Sixteen bytes from the fiber's `Random`. A boundary needs no secrecy: the encoder checks that
 * the content does not contain it, and draws another if it does.
 */
const randomBoundary: Effect.Effect<string> = Effect.map(
  Effect.all(Array.from({ length: 16 }, () => Random.nextIntBetween(0, 255))),
  (bytes) =>
    `effect-agent-browserbase-${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
);

const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  const first = needle[0];

  if (first === undefined || needle.length > haystack.length) return false;

  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      const expected = needle[j];

      if (expected === undefined || haystack[i + j] !== expected) continue outer;
    }

    return true;
  }

  return false;
};

/**
 * A deliberately small RFC 7578 encoder: one file part, an ASCII-quotable name and a
 * delimiter proven absent from the content. It performs no filesystem or stream work.
 */
export const encodeFilePart = Effect.fnUntraced(function* (
  part: MultipartFile,
  maxBytes: number,
  boundaries: Effect.Effect<string> = randomBoundary,
): Effect.fn.Return<MultipartResult> {
  if (
    !FIELD.test(part.field) ||
    !quotable(part.filename) ||
    !MEDIA_TYPE.test(part.mediaType) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 2 ** 31 - 1
  ) {
    return { _tag: "Rejected", reason: "configuration" };
  }
  if (part.bytes.byteLength > maxBytes) return { _tag: "Rejected", reason: "limit" };
  const encoder = new TextEncoder();

  for (let attempt = 0; attempt < 4; attempt++) {
    const boundary = yield* boundaries;

    if (!/^[A-Za-z0-9-]{1,70}$/.test(boundary)) continue;
    const delimiter = encoder.encode(boundary);

    if (contains(part.bytes, delimiter)) continue;

    const head = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.filename}"\r\nContent-Type: ${part.mediaType}\r\n\r\n`,
    );

    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.byteLength + part.bytes.byteLength + tail.byteLength);

    body.set(head, 0);
    body.set(part.bytes, head.byteLength);
    body.set(tail, head.byteLength + part.bytes.byteLength);

    return {
      _tag: "Encoded",
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    };
  }

  return { _tag: "Rejected", reason: "configuration" };
});
