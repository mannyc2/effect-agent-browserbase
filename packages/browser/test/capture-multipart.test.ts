import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { Target } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { sequentialCrypto } from "effect-browser/testing";

const frame = (sequence: number, bytes: ReadonlyArray<number>): Capture.CapturedFrame => ({
  bytes: Uint8Array.from(bytes),
  mediaType: "image/jpeg",
  target: Target.make({ generation: 1, pageId: "page-1", frameId: "frame-1" }),
  sequence,
  document: 0,
  sourceTimeMillis: 1000 + sequence,
  sourceClock: "presentation-unix-millis",
  receivedMonotonicNanos: BigInt(sequence),
  width: 1,
  height: 1,
  viewportWidth: 1,
  viewportHeight: 1,
});

const text = (chunks: ReadonlyArray<Uint8Array>) =>
  new TextDecoder("latin1").decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));

it.effect("multipart closes each frame with the next part's headers and names its boundary", () =>
  Effect.gen(function* () {
    const first = yield* Capture.multipart(Stream.make(frame(0, [1, 2]), frame(1, [3])));
    const second = yield* Capture.multipart(Stream.empty);
    const boundary = /boundary=(frame-[0-9a-f]{32})$/.exec(first.contentType)?.[1];

    expect(first.contentType.startsWith("multipart/x-mixed-replace; boundary=frame-")).toBe(true);
    expect(boundary).toBeDefined();
    // A boundary is drawn for each response.
    expect(second.contentType).not.toBe(first.contentType);

    const part = `--${String(boundary)}\r\nContent-Type: image/jpeg\r\n\r\n`;

    // A browser shows a part once it has read the next one's headers, so they follow each frame
    // at once; no metadata, identifier or address is written.
    expect(text(yield* Stream.runCollect(first.body))).toBe(
      `${part}\u0001\u0002\r\n${part}\u0003\r\n${part}--${String(boundary)}--\r\n`,
    );
  }).pipe(Effect.provide(sequentialCrypto)),
);
