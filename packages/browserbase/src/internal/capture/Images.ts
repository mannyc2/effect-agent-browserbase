import { BrowserError } from "../../Errors.ts";
const malformed = () => BrowserError.make({ operation: "image", reason: "malformed" });

/** Parse framing only; a caller decoding media must still validate its complete bitstream. */
export const pngGeometry = (bytes: Uint8Array): { width: number; height: number } => {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  if (
    bytes.length < 33 ||
    signature.some((b, i) => bytes[i] !== b) ||
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  )
    throw malformed();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(8) !== 13) throw malformed();

  const width = view.getUint32(16),
    height = view.getUint32(20);

  if (width === 0 || height === 0) throw malformed();

  return { width, height };
};

/** JPEG SOF dimensions avoid trusting the requested size or CSS viewport dimensions. */
export const jpegGeometry = (bytes: Uint8Array): { width: number; height: number } => {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw malformed();
  let offset = 2;

  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) throw malformed();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];

    if (marker === undefined || marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 1 >= bytes.length) throw malformed();
    const size = bytes[offset] * 256 + bytes[offset + 1];

    if (size < 2 || offset + size > bytes.length) throw malformed();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (size < 8) throw malformed();
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];

      if (width === 0 || height === 0) throw malformed();

      return { width, height };
    }
    offset += size;
  }
  throw malformed();
};
