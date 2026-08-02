/**
 * Minimal ZIP writer using the STORE method (no compression) + CRC32.
 *
 * Asset bundles are already compressed internally (LZ4/LZMA/etc.), so STORE is
 * fine, fast, and avoids pulling in a zip dependency. Produces standard ZIPs
 * readable by any unzip tool. File names are UTF-8 encoded (language-encoding
 * flag set). Does not support ZIP64 (files < 4GB each, < 64K entries).
 */

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// DOS date/time encoding (local time).
const toDosDateTime = (d: Date): [time: number, date: number] => {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return [time >>> 0, date >>> 0];
};

const writeU16 = (arr: number[], v: number) => {
  arr.push(v & 0xff, (v >>> 8) & 0xff);
};
const writeU32 = (arr: number[], v: number) => {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
};

export interface ZipEntry {
  /** File name inside the zip (use forward slashes for subfolders). */
  name: string;
  data: Uint8Array;
}

/** Build a STORE-only ZIP ArrayBuffer from entries. */
export function buildZipStore(entries: ZipEntry[]): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const central: number[] = [];
  let offset = 0;
  const [dosTime, dosDate] = toDosDateTime(new Date());
  const GP_UTF8 = 0x0800; // general-purpose bit 11: UTF-8 file names

  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const localHeaderLen = 30 + nameBytes.length;

    // Local file header (signature 0x04034b50).
    const local: number[] = [];
    writeU32(local, 0x04034b50);
    writeU16(local, 20); // version needed to extract
    writeU16(local, GP_UTF8); // flags: UTF-8 names
    writeU16(local, 0); // method: STORE
    writeU16(local, dosTime);
    writeU16(local, dosDate);
    writeU32(local, crc);
    writeU32(local, data.length); // compressed size
    writeU32(local, data.length); // uncompressed size
    writeU16(local, nameBytes.length);
    writeU16(local, 0); // extra field length
    chunks.push(new Uint8Array(local));
    chunks.push(nameBytes);
    chunks.push(data);

    // Central directory record (signature 0x02014b50).
    writeU32(central, 0x02014b50);
    writeU16(central, 20); // version made by
    writeU16(central, 20); // version needed
    writeU16(central, GP_UTF8); // flags
    writeU16(central, 0); // method: STORE
    writeU16(central, dosTime);
    writeU16(central, dosDate);
    writeU32(central, crc);
    writeU32(central, data.length);
    writeU32(central, data.length);
    writeU16(central, nameBytes.length); // file name length
    writeU16(central, 0); // extra field length
    writeU16(central, 0); // file comment length
    writeU16(central, 0); // disk number start
    writeU16(central, 0); // internal attrs
    writeU32(central, 0); // external attrs
    writeU32(central, offset); // local header offset
    for (const b of nameBytes) central.push(b);

    offset += localHeaderLen + data.length;
  }

  const centralBytes = new Uint8Array(central);
  const centralStart = offset;

  // End of central directory record (signature 0x06054b50).
  const eocd: number[] = [];
  writeU32(eocd, 0x06054b50);
  writeU16(eocd, 0); // disk number
  writeU16(eocd, 0); // disk with central dir
  writeU16(eocd, entries.length); // entries on this disk
  writeU16(eocd, entries.length); // total entries
  writeU32(eocd, centralBytes.length);
  writeU32(eocd, centralStart);
  writeU16(eocd, 0); // comment length

  chunks.push(centralBytes);
  chunks.push(new Uint8Array(eocd));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    result.set(c, p);
    p += c.length;
  }
  return result.buffer;
}
