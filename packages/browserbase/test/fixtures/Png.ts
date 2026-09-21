import { inflateSync } from "node:zlib";

/**
 * Just enough PNG to read a pixel a real browser painted: 8-bit RGB or RGBA, non-interlaced,
 * which is what Chromium's screenshots are. A test that asserts a colour should read the
 * pixels, not ask the page what colour it believes it is.
 */
export const decodePng = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const channels = bytes[25] === 6 ? 4 : 3;

  if (bytes[24] !== 8 || (bytes[25] !== 2 && bytes[25] !== 6) || bytes[28] !== 0)
    throw new Error("Unsupported PNG layout in a test fixture");
  const chunks: Array<Uint8Array> = [];

  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);

  const paeth = (left: number, up: number, upLeft: number) => {
    const estimate = left + up - upLeft;
    const [dl, du, dul] = [left, up, upLeft].map((value) => Math.abs(estimate - value));

    return dl <= du && dl <= dul ? left : du <= dul ? up : upLeft;
  };

  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixels[row * stride + i - channels] : 0;
      const up = row > 0 ? pixels[(row - 1) * stride + i] : 0;
      const upLeft = row > 0 && i >= channels ? pixels[(row - 1) * stride + i - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;

      pixels[row * stride + i] = (raw[row * (stride + 1) + 1 + i] + predicted) & 255;
    }
  }

  return {
    width,
    height,
    /** Red, green and blue at one CSS pixel of a `scale: "css"` screenshot. */
    rgb: (x: number, y: number): readonly [number, number, number] => {
      const at = (Math.floor(y) * width + Math.floor(x)) * channels;

      return [pixels[at], pixels[at + 1], pixels[at + 2]];
    },
  };
};
