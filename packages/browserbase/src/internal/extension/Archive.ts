/**
 * A bounded, allocation-free inspection of an extension ZIP: enough to prove a root
 * `manifest.json` and reject traversal before an upload, never an extractor. No entry is
 * decompressed and no path is written; the provider remains the loader of record.
 */
export interface ArchiveFacts {
  readonly entries: number;
  /** Uncompressed size the central directory itself declares, not a measured expansion. */
  readonly declaredBytes: number;
}

export type ArchiveRejection =
  | "signature"
  | "malformed"
  | "unsupported"
  | "name"
  | "manifest"
  | "limit";

export type ArchiveResult =
  | { readonly _tag: "Accepted"; readonly facts: ArchiveFacts }
  | { readonly _tag: "Rejected"; readonly reason: ArchiveRejection };

const MAX_ENTRIES = 4096;
const MAX_NAME_BYTES = 512;
const MAX_DECLARED_BYTES = 512 * 1024 * 1024;
const EOCD_SIZE = 22;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const rejected = (reason: ArchiveRejection): ArchiveResult => ({ _tag: "Rejected", reason });

const control = (name: string): boolean =>
  [...name].some((character) => character < " " || character === "\x7f");

/** Any `..` or rooted member would name a file outside the extension directory. */
const unsafeName = (name: string): boolean =>
  name.length === 0 ||
  name.startsWith("/") ||
  name.includes("\\") ||
  name.includes("//") ||
  /^[A-Za-z]:/.test(name) ||
  control(name) ||
  name.split("/").some((segment) => segment === "." || segment === "..");

export const inspectExtensionArchive = (archive: Uint8Array): ArchiveResult => {
  if (archive.byteLength < EOCD_SIZE) return rejected("malformed");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  if (u32(0) !== LOCAL_HEADER) return rejected("signature");

  // The comment is bounded by its own 16-bit length, so the record cannot hide further back.
  const earliest = Math.max(0, archive.byteLength - EOCD_SIZE - 0xffff);
  let end = -1;

  for (let offset = archive.byteLength - EOCD_SIZE; offset >= earliest; offset--) {
    if (u32(offset) === END_OF_CENTRAL_DIRECTORY) {
      end = offset;
      break;
    }
  }
  if (end < 0) return rejected("malformed");

  const entries = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryOffset = u32(end + 16);
  const commentLength = u16(end + 20);

  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== entries)
    return rejected("unsupported");
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    return rejected("unsupported");
  if (end + EOCD_SIZE + commentLength !== archive.byteLength) return rejected("malformed");
  if (directoryOffset + directorySize > end) return rejected("malformed");
  if (entries > MAX_ENTRIES) return rejected("limit");

  const names = new TextDecoder("utf-8", { fatal: true });
  const limit = directoryOffset + directorySize;
  let offset = directoryOffset;
  let declaredBytes = 0;
  let manifest = false;

  for (let index = 0; index < entries; index++) {
    if (offset + 46 > limit || u32(offset) !== CENTRAL_HEADER) return rejected("malformed");
    const declared = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const entryCommentLength = u16(offset + 32);
    const localOffset = u32(offset + 42);

    if (declared === 0xffffffff || localOffset === 0xffffffff) return rejected("unsupported");
    if (nameLength === 0 || nameLength > MAX_NAME_BYTES) return rejected("name");
    if (offset + 46 + nameLength + extraLength + entryCommentLength > limit)
      return rejected("malformed");
    if (localOffset >= directoryOffset) return rejected("malformed");

    let name: string;

    try {
      name = names.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      return rejected("name");
    }
    if (unsafeName(name)) return rejected("name");
    if (name === "manifest.json") manifest = true;
    declaredBytes += declared;
    if (declaredBytes > MAX_DECLARED_BYTES) return rejected("limit");
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (offset !== limit) return rejected("malformed");
  if (!manifest) return rejected("manifest");

  return { _tag: "Accepted", facts: { entries, declaredBytes } };
};
