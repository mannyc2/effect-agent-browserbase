/** A real stored-entry ZIP writer, so archive fixtures are genuine archives, not shaped bytes. */
export interface ZipEntry {
  readonly name: string;
  readonly content?: string;
}

const crcTable = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n++) {
    let value = n;

    for (let bit = 0; bit < 8; bit++)
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }

  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;

  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);

  return (value ^ 0xffffffff) >>> 0;
};

export interface ZipOptions {
  readonly comment?: string;
  /** Set the encryption flag the inspector must refuse. */
  readonly encrypted?: boolean;
  /** Declare a compression method other than stored or deflated. */
  readonly method?: number;
  /** Make the local header disagree with the directory about the member's name. */
  readonly localNameSuffix?: string;
}

export const buildZip = (
  entries: ReadonlyArray<ZipEntry>,
  options: ZipOptions = {},
): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const flags = 0x0800 | (options.encrypted === true ? 1 : 0);
  const method = options.method ?? 0;
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const localName = encoder.encode(`${entry.name}${options.localNameSuffix ?? ""}`);
    const content = encoder.encode(entry.content ?? "");
    const checksum = crc32(content);
    const local = new Uint8Array(30 + localName.byteLength + content.byteLength);
    const localView = new DataView(local.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, content.byteLength, true);
    localView.setUint32(22, content.byteLength, true);
    localView.setUint16(26, localName.byteLength, true);
    local.set(localName, 30);
    local.set(content, 30 + localName.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);

    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, content.byteLength, true);
    centralView.setUint32(24, content.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }

  const comment = encoder.encode(options.comment ?? "");
  const directorySize = centrals.reduce((total, part) => total + part.byteLength, 0);
  const total = offset + directorySize + 22 + comment.byteLength;
  const archive = new Uint8Array(total);
  let cursor = 0;

  for (const local of locals) {
    archive.set(local, cursor);
    cursor += local.byteLength;
  }
  for (const central of centrals) {
    archive.set(central, cursor);
    cursor += central.byteLength;
  }
  const end = new DataView(archive.buffer, cursor, 22);

  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, comment.byteLength, true);
  archive.set(comment, cursor + 22);

  return archive;
};

export const extensionArchive = (extra: ReadonlyArray<ZipEntry> = []): Uint8Array =>
  buildZip([
    { name: "manifest.json", content: '{"manifest_version":3,"name":"fixture","version":"1.0"}' },
    ...extra,
  ]);
