const dl: Record<number, Uint8Array> = {
  0: new TextEncoder().encode('X@85Pq!6v$lCt7UYsihH3!cPb1P71bo4lX59FXqY!VO$YiYsu!Keu3aVZwi5on5l'),
  1: new TextEncoder().encode('hAi5luE8FlyblDdCTQC9uxnj3rkNwd1swrKI7Mx1aDFEe2B5h#3X&s54%GuSeHf@'),
};

const fl: Record<string, number> = {
  UnityKHFS: 0,
  UnityKHNFS: 1,
  UnityKH1FS: 2,
};

export const KH_KEYS = dl;
export const KH_FORMATS = fl;

// ArchiveFlags (与 bundle.ts 中的定义一致)
const BLOCKS_INFO_AT_THE_END = 0x80;
const BLOCK_INFO_NEED_PADDING_AT_START = 0x200;

export function xorDecrypt(data: Uint8Array, key: Uint8Array) {
  const result = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ key[i % key.length];
  }
  return result as Uint8Array<ArrayBuffer>;
}

export function rotateBytes(data: Uint8Array, start: number, length: number, amount: number) {
  let i = data.length - 1;
  let t = Math.min(i, start);
  let a = Math.min(i, t + length - 1);
  let n = a - t + 1;
  if (n < 2) return data as Uint8Array<ArrayBuffer>;
  let o = amount % n;
  if (o === 0) return data as Uint8Array<ArrayBuffer>;
  let s = a - o;
  s = Math.min(Math.max(s, t), a);
  function reverseRange(low: number, high: number) {
    while (low < high) {
      const temp = data[low];
      data[low] = data[high];
      data[high] = temp;
      low++;
      high--;
    }
  }
  reverseRange(t, s);
  reverseRange(s + 1, a);
  reverseRange(t, a);
  return data as Uint8Array<ArrayBuffer>;
}

export function isKhBundle(data: ArrayBuffer): boolean {
  if (data.byteLength < 10) return false;
  const t = new Uint8Array(data);
  let n = -1;
  for (let i = 0; i < Math.min(t.length, 12); i++) {
    if (t[i] === 0) {
      n = i;
      break;
    }
  }
  if (n === -1) return false;
  const sig = String.fromCharCode(...t.slice(0, n));
  return Object.keys(fl).includes(sig);
}

export function isUnityFs(data: ArrayBuffer): boolean {
  if (data.byteLength < 7) return false;
  const t = new Uint8Array(data, 0, 7);
  return String.fromCharCode(...t) === 'UnityFS';
}

/** 16 字节对齐（与 UABEA Align16 一致） */
export function align16(value: number): number {
  return (value + 15) & ~15;
}

/** 在 data 中从 start 开始查找 null 终止符位置 */
function findNullTerminator(t: Uint8Array, start: number): number {
  for (let i = start; i < t.length; i++) {
    if (t[i] === 0) return i;
  }
  throw new Error('Failed to find null terminator while parsing header');
}

/** 读取 null 终止字符串 */
function readNullTerminated(t: Uint8Array, start: number): [string, number] {
  const end = findNullTerminator(t, start);
  return [new TextDecoder().decode(t.slice(start, end)), end + 1];
}

export interface ParsedBundleHeader {
  magicLength: number;
  version: number;
  generationVersion: string;
  engineVersion: string;
  sizeOffset: number;
  recordedFileSize: bigint;
  blocksInfoSize: number;
  uncompressedBlocksInfoSize: number;
  flags: number;
  headerEnd: number;
  /** blocksInfo/加密块 在文件中的起始偏移（含对齐） */
  dataOffset: number;
}

/**
 * 解析 UnityFS/KH bundle 头部（与 UABEA 的 ParseBundleHeader 一致）。
 *
 * 正确处理变长 generationVersion/engineVersion 字符串，
 * 并根据 BLOCK_INFO_NEED_PADDING_AT_START flag 计算 dataOffset。
 *
 * @param t   文件数据
 * @param magicLength  magic 长度（含 null 终止符）
 */
export function parseBundleHeader(t: Uint8Array, magicLength: number): ParsedBundleHeader {
  let ptr = magicLength;
  // version (4 bytes BE)
  const version = new DataView(t.buffer, t.byteOffset + ptr, 4).getUint32(0, false);
  ptr += 4;
  // generationVersion (null-terminated)
  const [generationVersion, ptr2] = readNullTerminated(t, ptr);
  ptr = ptr2;
  // engineVersion (null-terminated)
  const [engineVersion, ptr3] = readNullTerminated(t, ptr);
  ptr = ptr3;
  // size (8 bytes BE)
  const sizeOffset = ptr;
  const recordedFileSize = new DataView(t.buffer, t.byteOffset + ptr, 8).getBigUint64(0, false);
  ptr += 8;
  // blocksInfoSize (4 bytes BE) — compressed blocks info size
  const blocksInfoSize = new DataView(t.buffer, t.byteOffset + ptr, 4).getUint32(0, false);
  ptr += 4;
  // uncompressedBlocksInfoSize (4 bytes BE)
  const uncompressedBlocksInfoSize = new DataView(t.buffer, t.byteOffset + ptr, 4).getUint32(0, false);
  ptr += 4;
  // flags (4 bytes BE)
  const flags = new DataView(t.buffer, t.byteOffset + ptr, 4).getUint32(0, false);
  ptr += 4;
  const headerEnd = ptr;

  // dataOffset: 当 !BLOCKS_AT_END && BLOCK_INFO_NEED_PADDING_AT_START 时，对齐 16
  // (与 UABEA ParseBundleHeader 一致，不依赖 version >= 7)
  let dataOffset = headerEnd;
  if ((flags & BLOCKS_INFO_AT_THE_END) === 0 && (flags & BLOCK_INFO_NEED_PADDING_AT_START) !== 0) {
    dataOffset = align16(headerEnd);
  }

  return {
    magicLength,
    version,
    generationVersion,
    engineVersion,
    sizeOffset,
    recordedFileSize,
    blocksInfoSize,
    uncompressedBlocksInfoSize,
    flags,
    headerEnd,
    dataOffset,
  };
}

/**
 * 获取 UnityFS buffer 中 s 块（cBS+uncBS+flags）的偏移。
 * s 块紧跟在 size 字段之后，偏移 = sizeOffset + 8。
 */
export function getSBlockOffset(t: Uint8Array): number {
  // 跳过 "UnityFS\0"(8) + version(4) + genVer\0 + engVer\0
  let ptr = 8 + 4;
  ptr = findNullTerminator(t, ptr) + 1;
  ptr = findNullTerminator(t, ptr) + 1;
  // 现在 ptr 指向 size 字段
  return ptr + 8; // 跳过 size(8)，s 块从这开始
}

/**
 * 解密 KH bundle 为标准 UnityFS 格式。
 *
 * 严格匹配 UABEA 的 DecryptBundleToUnityFs：
 * 1. 正确解析变长头部字符串（generationVersion/engineVersion）
 * 2. 根据 BLOCK_INFO_NEED_PADDING_AT_START flag 计算 dataOffset
 * 3. 输出布局：UnityFS\0 + header字段 + padding + 解密blocksInfo + 剩余数据
 * 4. size 字段设为 result.Length
 */
export function decryptKhBundle(data: ArrayBuffer): ArrayBuffer {
  const t = new Uint8Array(data);
  // 查找 magic null 终止符
  let n = -1;
  for (let i = 0; i < Math.min(t.length, 12); i++) {
    if (t[i] === 0) {
      n = i;
      break;
    }
  }
  if (n === -1) throw new Error('Invalid magic: no null terminator');
  const signature = String.fromCharCode(...t.slice(0, n));
  const fmt = fl[signature];
  if (fmt === undefined) throw new Error(`Unsupported magic: ${signature}`);
  const magicLength = n + 1;

  // 解析头部（与 UABEA 的 ParseBundleHeader 一致）
  const header = parseBundleHeader(t, magicLength);
  const { headerEnd, dataOffset, blocksInfoSize: c } = header;

  // 提取加密块
  const encryptedChunk = t.slice(dataOffset, dataOffset + c) as Uint8Array<ArrayBuffer>;

  // 解密
  let l = encryptedChunk;
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, BigInt(c), false);

  if (fmt === 0) {
    l = xorDecrypt(l, dl[0]);
  } else if (fmt === 1) {
    l = xorDecrypt(l, dl[1]);
    l = xorDecrypt(l, d);
  } else if (fmt === 2) {
    const eRot = ((l.length % 7) + 7) % l.length;
    l = rotateBytes(l, 0, l.length, eRot);
    const tKey = Number(c % 3 === 0 || c % 5 === 0 || c % 7 === 0);
    const nKey = dl[tKey];
    l = xorDecrypt(l, nKey);
    l = xorDecrypt(l, d);
    if (eRot !== 0) {
      const rRot = ((l.length % 7) + 1) % eRot;
      for (let tI = 0; tI < l.length; tI += eRot) {
        l = rotateBytes(l, tI, eRot, rRot);
      }
      l = rotateBytes(l, 0, l.length, rRot);
    }
  }

  // 构建输出（严格匹配 UABEA 的 DecryptBundleToUnityFs）
  const standardMagic = new TextEncoder().encode('UnityFS\0'); // 8 bytes
  // headerFields = version(4) + genVer\0 + engVer\0 + size(8) + cBS(4) + uncBS(4) + flags(4)
  const headerFields = t.slice(magicLength, headerEnd);
  // padding 填充 UnityFS header 到 dataOffset
  const paddingLength = dataOffset - (standardMagic.length + headerFields.length);
  // 加密块之后的剩余数据
  const restOffset = dataOffset + c;
  const rest = restOffset < t.length ? t.slice(restOffset) : new Uint8Array(0);

  const totalLen = standardMagic.length + headerFields.length + Math.max(0, paddingLength) + l.length + rest.length;
  const result = new Uint8Array(totalLen);
  let pos = 0;
  result.set(standardMagic, pos); pos += standardMagic.length;
  result.set(headerFields, pos); pos += headerFields.length;
  // padding（零字节，已在 Uint8Array 初始化中填充）
  pos += Math.max(0, paddingLength);
  result.set(l, pos); pos += l.length;
  result.set(rest, pos);

  // 修正 size 字段（与 UABEA 一致：设为 result.Length）
  const newSizeOffset = standardMagic.length + (header.sizeOffset - magicLength);
  if (newSizeOffset + 8 <= result.length) {
    new DataView(result.buffer, result.byteOffset + newSizeOffset, 8)
      .setBigUint64(0, BigInt(result.length), false);
  }

  return result.buffer;
}

export interface KhBundleMeta {
  signature: string;
  header: Uint8Array;
  tail: Uint8Array;
}

/**
 * 将原始加密 KH bundle 切分为 header + tail，用于无损回写。
 *
 * header = 加密块之前的所有数据（magic + 头部字段 + padding）
 * tail = 加密块之后的所有数据
 *
 * 正确处理变长字符串头部和 BLOCK_INFO_NEED_PADDING_AT_START 对齐。
 */
export function splitKhBundle(data: ArrayBuffer): KhBundleMeta {
  const t = new Uint8Array(data);
  let n = -1;
  for (let i = 0; i < Math.min(t.length, 12); i++) {
    if (t[i] === 0) {
      n = i;
      break;
    }
  }
  if (n === -1) throw new Error('Invalid magic: no null terminator');
  const signature = String.fromCharCode(...t.slice(0, n));
  const fmt = fl[signature];
  if (fmt === undefined) throw new Error(`Unsupported magic: ${signature}`);
  const magicLength = n + 1;

  // 解析头部以找到加密块位置
  const header = parseBundleHeader(t, magicLength);
  const { dataOffset, blocksInfoSize: c } = header;

  // header = 加密块之前的所有数据
  const headerBytes = t.slice(0, dataOffset);
  // tail = 加密块之后的所有数据
  const tail = t.slice(dataOffset + c);
  return { signature, header: headerBytes, tail };
}
