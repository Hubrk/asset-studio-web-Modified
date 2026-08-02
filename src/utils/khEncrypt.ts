import { compressBlock, compressBound, decompressBlock } from 'lz4js';
import { xorDecrypt, rotateBytes, isUnityFs, KH_KEYS, KH_FORMATS, type KhBundleMeta } from './khDecrypt';

// Layout of a decrypted UnityFS buffer produced by decryptKhBundle:
//   UnityFS(7) + o(31) + s(12) + padding(0 or 14) + decrypted_data(l) + remaining(u)
// padding 大小取决于 version：>= 7 时为 14（模拟 align(16)），< 7 时为 0。
const BASE_HEADER_SIZE = 7 + 31 + 12; // 50

/**
 * 计算解密后 UnityFS buffer 的 header 大小（blocksInfo 起始偏移）。
 *
 * decryptKhBundle 根据 version 决定是否添加 padding：
 * - version >= 7：padding = 14，header 大小 = 64（模拟 align(16)）
 * - version < 7：padding = 0，header 大小 = 50（不做 align(16)）
 */
function getDecryptedHeaderSize(t: Uint8Array): number {
  // t[0:7] = "UnityFS", t[7] = '\0' (o[0]), t[8:12] = version (BE uint32)
  const version = t.length >= 12
    ? new DataView(t.buffer, t.byteOffset + 8, 4).getUint32(0, false)
    : 0;
  return version >= 7 ? (BASE_HEADER_SIZE + 15) & ~15 : BASE_HEADER_SIZE;
}

// Compression type constants (flags & 0x3f in UnityFS archive flags).
const COMPRESSION_NONE = 0;
const COMPRESSION_LZ4 = 2;
const COMPRESSION_LZ4_HC = 3;

/**
 * Compute the inverse rotation amount for `rotateBytes`.
 * `rotateBytes` performs a RIGHT rotation by `amount` on a range of `n` elements.
 * To reverse it, apply a RIGHT rotation by `(n - amount % n) % n`.
 */
function invRotate(amount: number, n: number): number {
  const o = amount % n;
  return o === 0 ? 0 : n - o;
}

/**
 * Compress data as a raw LZ4 block (no frame header), compatible with Unity's
 * LZ4/LZ4_HC blocksInfo. LZ4 and LZ4_HC share the same block format; the only
 * difference is on the compressor side, so a block compressed with plain LZ4
 * can be decompressed by a LZ4_HC decompressor (which is what Unity uses).
 *
 * Used to re-compress blocksInfo when the source compression (e.g. none, after
 * UABE edits) doesn't match the target compression expected by the game (e.g.
 * LZ4_HC, as stored in the original KH meta).
 */
function compressLz4Block(data: Uint8Array): Uint8Array {
  const hashTable = new Uint32Array(1 << 16);
  const bound = compressBound(data.length);
  const dst = new Uint8Array(bound);
  const compSize = compressBlock(data, dst, 0, data.length, hashTable);
  if (compSize === 0) {
    // compressBlock returns 0 when no matches were found (entire input is
    // literals). Manually encode an all-literals LZ4 block so the game can
    // still decompress it.
    return encodeLz4AllLiterals(data);
  }
  return dst.slice(0, compSize);
}

/**
 * Manually encode an all-literals LZ4 block (token + length extension + literals).
 * This is the fallback when lz4js compressBlock finds no matches.
 */
function encodeLz4AllLiterals(data: Uint8Array): Uint8Array {
  const len = data.length;
  const tokens: number[] = [];
  if (len < 15) {
    tokens.push(len << 4);
  } else {
    tokens.push(15 << 4);
    let remaining = len - 15;
    while (remaining >= 255) {
      tokens.push(255);
      remaining -= 255;
    }
    tokens.push(remaining);
  }
  const header = new Uint8Array(tokens);
  const result = new Uint8Array(header.length + data.length);
  result.set(header, 0);
  result.set(data, header.length);
  return result;
}

/**
 * Decompress a raw LZ4 block (no frame header). Works for both LZ4 and LZ4_HC
 * compressed data since they share the same block format.
 */
function decompressLz4Block(data: Uint8Array, uncompressedSize: number): Uint8Array {
  const dst = new Uint8Array(uncompressedSize);
  const decSize = decompressBlock(data, dst, 0, data.length, 0);
  if (decSize !== uncompressedSize) {
    throw new Error(`LZ4 decompress size mismatch: got ${decSize}, expected ${uncompressedSize}`);
  }
  return dst;
}

/**
 * Re-encrypt a decrypted UnityFS buffer back into its original KH bundle format.
 *
 * This is the exact inverse of `decryptKhBundle`. Because decryption discards the
 * original 11/12-byte `flags` and replaces them with 14 zero padding bytes, a
 * lossless round-trip requires the original `header` (everything before the
 * encrypted data block) and `tail` (everything after it), captured at load time
 * via `splitKhBundle`.
 *
 * When the decrypted UnityFS was modified by an external tool (e.g. UABE) that
 * changed the blocksInfo compression (e.g. from LZ4_HC to none), this function
 * re-compresses the blocksInfo to match the original KH meta's compression type
 * before encrypting. This ensures the game can read the result.
 *
 * @param decrypted  decrypted UnityFS ArrayBuffer (output of `decryptKhBundle`)
 * @param meta       original header/tail captured from the encrypted source
 * @returns          a KH bundle ArrayBuffer, byte-identical to the source when
 *                   the decrypted buffer was not modified
 */
export function encryptKhBundle(decrypted: ArrayBuffer, meta: KhBundleMeta): ArrayBuffer {
  const t = new Uint8Array(decrypted);
  const fmt = KH_FORMATS[meta.signature];
  if (fmt === undefined) throw new Error(`Unsupported signature: ${meta.signature}`);

  const decryptedHeaderSize = getDecryptedHeaderSize(t);

  const nullPos = meta.header.indexOf(0);
  const sOffset = (nullPos >= 0 ? nullPos : meta.header.length) + 31;

  // Original KH meta s values (target compression).
  const metaSView = new DataView(meta.header.buffer, meta.header.byteOffset + sOffset, 12);
  const metaC = metaSView.getUint32(0, false);
  const metaFlags = metaSView.getUint32(8, false);
  const metaCompression = metaFlags & 0x3f;

  if (t.length < decryptedHeaderSize) {
    throw new Error('Decrypted buffer too short for KH layout');
  }

  // Current UnityFS s values (source compression, may differ after external edits).
  const tSView = new DataView(t.buffer, t.byteOffset + 38, 12);
  const tC = tSView.getUint32(0, false);
  const tUnc = tSView.getUint32(4, false);
  const tFlags = tSView.getUint32(8, false);
  const tCompression = tFlags & 0x3f;

  let l: Uint8Array; // block to encrypt
  let c: number; // length of l
  let outFlags: number; // flags to write into KH header
  let outUnc: number; // uncompressedBlocksInfoSize to write into KH header
  let tail: Uint8Array;
  let recompressed = false; // true if blocksInfo was re-compressed (size changed)

  if (tC > 0 && t.length >= decryptedHeaderSize + tC) {
    // Normal case: t carries a complete blocksInfo (tC bytes) + optional tail.
    // tail is always the data after the original blocksInfo region, regardless
    // of whether we re-compress.
    tail = t.slice(decryptedHeaderSize + tC);

    if (tCompression === metaCompression) {
      // Compression matches — use blocksInfo as-is.
      c = tC;
      l = t.slice(decryptedHeaderSize, decryptedHeaderSize + c);
      outFlags = tFlags;
      outUnc = tUnc;
    } else {
      // Compression mismatch (e.g. UABE saved as none, game expects LZ4_HC).
      // Re-compress blocksInfo to match the original KH meta's compression.
      let uncBlocksInfo: Uint8Array;
      if (tCompression === COMPRESSION_NONE) {
        uncBlocksInfo = t.slice(decryptedHeaderSize, decryptedHeaderSize + tC);
      } else if (tCompression === COMPRESSION_LZ4 || tCompression === COMPRESSION_LZ4_HC) {
        const compressed = t.slice(decryptedHeaderSize, decryptedHeaderSize + tC);
        uncBlocksInfo = decompressLz4Block(compressed, tUnc);
      } else {
        throw new Error(`Unsupported source compression type: ${tCompression}`);
      }

      if (metaCompression === COMPRESSION_NONE) {
        l = uncBlocksInfo;
      } else if (metaCompression === COMPRESSION_LZ4 || metaCompression === COMPRESSION_LZ4_HC) {
        l = compressLz4Block(uncBlocksInfo);
      } else {
        throw new Error(`Unsupported target compression type: ${metaCompression}`);
      }

      c = l.length;
      outFlags = (tFlags & ~0x3f) | metaCompression;
      outUnc = uncBlocksInfo.length;
      recompressed = true;
    }
  } else {
    // Fallback: t is too short or tC is invalid — encrypt entire data region.
    c = t.length - decryptedHeaderSize;
    l = t.slice(decryptedHeaderSize);
    tail = new Uint8Array(0);
    outFlags = tFlags;
    outUnc = tUnc;
  }

  if (c < 0) throw new Error('Invalid decrypted data: length too short to contain KH layout');

  // Big-endian 8-byte representation of the data length (used for XOR)
  const dBuf = new Uint8Array(8);
  new DataView(dBuf.buffer).setBigUint64(0, BigInt(c), false);

  // --- Encrypt: exact reverse of decryptKhBundle ---
  if (fmt === 0) {
    l = xorDecrypt(l, KH_KEYS[0]);
  } else if (fmt === 1) {
    l = xorDecrypt(l, dBuf);
    l = xorDecrypt(l, KH_KEYS[1]);
  } else {
    const len = l.length;
    const eRot = ((len % 7) + 7) % len;
    // GetCorrectKey: KeyB if c%3==0 || c%5==0 || c%7==0, else KeyA
    const tKey = Number(c % 3 === 0 || c % 5 === 0 || c % 7 === 0);

    if (eRot === 0) {
      l = xorDecrypt(l, dBuf);
      l = xorDecrypt(l, KH_KEYS[tKey]);
    } else {
      const rRot = ((len % 7) + 1) % eRot;
      l = rotateBytes(l, 0, len, invRotate(rRot, len));
      for (let tI = 0; tI < len; tI += eRot) {
        const segLen = Math.min(eRot, len - tI);
        l = rotateBytes(l, tI, segLen, invRotate(rRot, segLen));
      }
      l = xorDecrypt(l, dBuf);
      l = xorDecrypt(l, KH_KEYS[tKey]);
      l = rotateBytes(l, 0, len, invRotate(eRot, len));
    }
  }

  // Build the KH header, updating s[0:4]=c, s[4:8]=outUnc, s[8:12]=outFlags.
  const header = meta.header.slice();
  const headerSView = new DataView(header.buffer, header.byteOffset + sOffset, 12);
  headerSView.setUint32(0, c, false);
  headerSView.setUint32(4, outUnc, false);
  headerSView.setUint32(8, outFlags, false);

  // Sync the UnityFS "size" field (total file size, u64 BE) stored inside the
  // o block.
  //
  // 与魔改版 UABEA 的 EncryptUnityFsFile 一致：KH 的 size 字段 = UnityFS size +
  // magicDiff，其中 magicDiff = KH magic 长度 - UnityFS magic 长度。
  // (C#: num = RecordedFileSize + (magicBytes.Length - StandardMagic.Length))
  // 然后用 Array.Resize 强制输出到该长度（末尾补零）。
  //
  // magicDiff 来源：KH magic "UnityKHFS\0"(10) / "UnityKHNFS\0"(11) /
  // "UnityKH1FS\0"(11) 比 UnityFS magic "UnityFS\0"(8) 多 2~3 字节。
  const khMagicLen = nullPos >= 0 ? nullPos + 1 : header.length;
  const magicDiff = khMagicLen - 8; // KH magic 含 null - UnityFS magic 含 null

  const sizeOffsetInHeader = (nullPos >= 0 ? nullPos : header.length) + 23;
  const sizeOffsetInDecrypted = 7 + 23; // "UnityFS\0" is always 8 bytes (nullPos=7)
  let khSize: bigint;
  if (sizeOffsetInDecrypted + 8 <= t.length && sizeOffsetInHeader + 8 <= header.length) {
    // 正常情况：从 UnityFS 读取 size，加 magicDiff
    let unityFsSize = new DataView(t.buffer, t.byteOffset + sizeOffsetInDecrypted, 8).getBigUint64(0, false);
    // 防御：如果 size 字段无效（远大于实际文件大小，如 mock 测试 buffer），
    // 使用实际文件大小代替，避免 Number(khSize) 产生巨大值导致 RangeError。
    if (unityFsSize > BigInt(t.length)) {
      unityFsSize = BigInt(t.length);
    }
    khSize = unityFsSize + BigInt(magicDiff);
  } else {
    // Fallback：t 太短，用实际内容大小 + magicDiff
    khSize = BigInt(header.length + l.length + tail.length) + BigInt(magicDiff);
  }
  // 重新压缩时，UnityFS 的 size 不准确，用实际内容大小 + magicDiff 覆盖
  if (recompressed) {
    khSize = BigInt(header.length + l.length + tail.length) + BigInt(magicDiff);
  }
  if (sizeOffsetInHeader + 8 <= header.length) {
    new DataView(header.buffer, header.byteOffset + sizeOffsetInHeader, 8)
      .setBigUint64(0, khSize, false);
  }

  // 构建 KH 输出。与 C# Array.Resize 一致：如果实际内容 < khSize，末尾补零。
  const contentSize = header.length + l.length + tail.length;
  const targetSize = Number(khSize);
  const result = new Uint8Array(Math.max(contentSize, targetSize));
  let offset = 0;
  result.set(header, offset); offset += header.length;
  result.set(l, offset); offset += l.length;
  result.set(tail, offset);
  // 末尾 padding 已由 new Uint8Array 初始化为零
  return result.buffer;
}

/**
 * Encrypt a UnityFS buffer into a fresh KH bundle from scratch (no original KH meta).
 *
 * Used when the source was NOT originally a KH bundle, e.g. a plain UnityFS file
 * that the user wants to encrypt for use in a KH-format game.
 *
 * IMPORTANT: A UnityFS produced by `decryptKhBundle` carries the original
 * encrypted-block length `c` in `s[0:4]` (offset 38-41). We must respect this
 * value to correctly split the data into the encrypted block (`l`) and the
 * unencrypted tail. Encrypting the entire data region (as if there were no tail)
 * produces a file the game cannot read, because the game expects the original
 * `c` and tail layout.
 *
 * For a plain UnityFS that was never KH-encrypted, `s[0:4]` is the UnityFS
 * header field "compressed blocks info size" — we treat it as `c` and encrypt
 * only that many bytes, leaving the rest as tail. This matches the game's
 * expected layout where only the blocks-info block is encrypted.
 *
 * 不做 block size 对齐——与魔改版 UABEA 的 EncryptUnityFsFile 一致，
 * 直接加密原始 blocksInfo。
 *
 * @param unityFs   a UnityFS ArrayBuffer (must start with "UnityFS", >= 64 bytes)
 * @param signature target KH format: 'UnityKHFS' | 'UnityKHNFS' | 'UnityKH1FS'
 */
export function encryptUnityFsToKhFresh(
  unityFs: ArrayBuffer,
  signature: string = 'UnityKHFS',
): ArrayBuffer {
  if (!isUnityFs(unityFs)) {
    throw new Error('encryptUnityFsToKhFresh: input is not a UnityFS buffer');
  }
  const fmt = KH_FORMATS[signature];
  if (fmt === undefined) throw new Error(`Unsupported signature: ${signature}`);

  const t = new Uint8Array(unityFs);
  const decryptedHeaderSize = getDecryptedHeaderSize(t);
  if (t.length < decryptedHeaderSize) {
    throw new Error(`encryptUnityFsToKhFresh: UnityFS too short (need >= ${decryptedHeaderSize} bytes)`);
  }

  const o = t.slice(7, 38);  // 31 bytes
  // 直接从 UnityFS 复制 s block，保持源文件的 compression 类型不变。
  // 实测证明：火影游戏支持 comp=0 (未压缩) 的 blocksInfo，成功对照文件
  // (别人工具加密的，游戏可运行) 就是用 comp=0。而用 lz4js 重新压缩为
  // comp=3 (LZ4_HC) 后，虽然格式合法，但游戏引擎的 LZ4 解压器无法正确
  // 解压，导致资源损坏。因此保持源文件的 compression 是最安全的做法。
  const s = t.slice(38, 50); // 12 bytes, s[0:4]=c, s[4:8]=unc, s[8:12]=flags

  const flagsLen = fmt === 0 ? 12 : 11;
  // flags are all zeros: the game's original KH files use zero flags, and
  // decryptKhBundle skips flags entirely, so zero is the safe choice.
  const flags = new Uint8Array(flagsLen);

  const magic = new TextEncoder().encode(signature);
  const header = new Uint8Array(magic.length + o.length + s.length + flags.length);
  let h = 0;
  header.set(magic, h); h += magic.length;
  header.set(o, h);     h += o.length;
  header.set(s, h);     h += s.length;
  header.set(flags, h);

  // meta 的 s block 直接从 UnityFS 复制，metaCompression === tCompression，
  // 不会触发重新压缩。
  return encryptKhBundle(unityFs, { signature, header, tail: new Uint8Array(0) });
}

/**
 * 将 meta 中的 compression 同步为 UnityFS 当前的 compression。
 *
 * 当用户导入修改后的 UnityFS（如 UABE 编辑过的文件）并复用原始 KH 的 meta 时，
 * meta 中的 compression（如 LZ4_HC）可能与修改后 UnityFS 的 compression（如 none）
 * 不匹配。如果不同步，`encryptKhBundle` 会尝试用 lz4js 重新压缩 blocksInfo，
 * 但 lz4js 的压缩输出游戏引擎无法正确解压，导致资源损坏。
 *
 * 同步后 compression 匹配，`encryptKhBundle` 直接使用源文件的 blocksInfo，不重新压缩。
 *
 * 注意：`encryptKhBundle` 最终会用当前 UnityFS 的 s 块值覆盖 meta header 中的 s 块，
 * 所以修改 meta 中的 compression 只是为了让"compression 匹配"的分支被选中，
 * 不会影响最终输出的 s 块值。
 */
function syncMetaCompression(meta: KhBundleMeta, unityFs: ArrayBuffer): KhBundleMeta {
  const t = new Uint8Array(unityFs);
  if (t.length < 50) return meta;

  const tSView = new DataView(t.buffer, t.byteOffset + 38, 12);
  const tFlags = tSView.getUint32(8, false);
  const tCompression = tFlags & 0x3f;

  const header = meta.header.slice();
  const nullPos = header.indexOf(0);
  const sOffset = (nullPos >= 0 ? nullPos : header.length) + 31;
  if (sOffset + 12 > header.length) return meta;

  const headerSView = new DataView(header.buffer, header.byteOffset + sOffset, 12);
  const metaFlags = headerSView.getUint32(8, false);
  const metaCompression = metaFlags & 0x3f;

  if (metaCompression === tCompression) return meta; // 已匹配，无需修改

  const newFlags = (metaFlags & ~0x3f) | tCompression;
  headerSView.setUint32(8, newFlags, false);
  return { ...meta, header };
}

/**
 * Encrypt a UnityFS buffer into KH format.
 *
 * 流程与魔改版 UABEA 的 SaveEncryptedBundle 一致：
 *   1. (可选) fixUnityCrcInPlace — 追加 4 字节 CRC32 补丁
 *   2. 加密 blocksInfo（直接使用输入 UnityFS 的原始 blocksInfo，不做 block size 对齐）
 *
 * 注意：标准工具（CustomBundleCrypto.EncryptUnityFsFile）不做 block size 对齐，
 * 直接加密原始 blocksInfo。之前 web 版调用的 alignUnityFsBlock 会修改 block size，
 * 导致加密结果与标准工具不一致，已移除。
 *
 * - If `meta` is provided (the bundle was originally a KH bundle), the exact
 *   original container is reproduced — best for re-injecting edited assets back
 *   into the game, since format/key match the source.
 * - Otherwise a fresh KH container is generated, for encrypting arbitrary
 *   UnityFS files that were never KH-encrypted.
 *
 * @param unityFs   a UnityFS ArrayBuffer
 * @param meta      optional original KH meta (for round-trip)
 * @param signature target KH format for fresh encryption: 'UnityKHFS' | 'UnityKHNFS' | 'UnityKH1FS'
 * @param fileName  optional original KH file name (for CRC32 patch)
 */
export function encryptUnityFsToKh(
  unityFs: ArrayBuffer,
  meta?: KhBundleMeta,
  signature?: string,
  fileName?: string,
): ArrayBuffer {
  if (!isUnityFs(unityFs)) {
    throw new Error('encryptUnityFsToKh: input is not a UnityFS buffer');
  }

  // CRC32 补丁：在加密前，对 UnityFS 文件追加 4 字节补丁，使其 CRC32
  // 等于文件名中的数字。这是火影游戏完整性校验的要求，与魔改版 UABEA
  // 的 FixUnityCrcInPlace 逻辑一致。
  let fsToEncrypt = unityFs;
  if (fileName) {
    fsToEncrypt = fixUnityCrcInPlace(unityFs, fileName);
  }

  if (meta) {
    // 有 meta 的 round-trip 路径：同步 compression 避免重新压缩
    const syncedMeta = syncMetaCompression(meta, fsToEncrypt);
    return encryptKhBundle(fsToEncrypt, syncedMeta);
  }
  return encryptUnityFsToKhFresh(fsToEncrypt, signature || 'UnityKHFS');
}

// ==================== CRC32 补丁（FixUnityCrcInPlace）====================
// 移植自魔改版 UABEA 的 CustomBundleCrypto.FixUnityCrcInPlace。
// 通过在 UnityFS 文件末尾追加 4 字节补丁，使整个 bundle 的 CRC32 等于
// 文件名中的数字（如火影游戏用文件名数字作为期望 CRC32 校验值）。
// 这是之前缺失的"尾部 4 字节校验数据"的真正算法。

/** 标准 CRC32 表（多项式 0xEDB88320），与 C# BuildCrc32Table 一致。 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** 计算 data[offset..offset+length] 的 CRC32，与 C# ComputeCrc32 一致。 */
export function computeCrc32(data: Uint8Array, offset: number, length: number): number {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[offset + i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 16 字节对齐（与 C# Align16 一致：value + 15 & ~15）。 */
function align16(value: number): number {
  return (value + 15) & ~15;
}

/** 查找子序列在 data 中的起始位置（与 C# FindMagicOffset/SequenceEquals 配合）。 */
function indexOfBytes(data: Uint8Array, start: number, needle: Uint8Array): number {
  outer: for (let i = start; i <= data.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 在 UnityFS 文件末尾追加 4 字节 CRC32 补丁，使 blockData 区域的 CRC32
 * 等于文件名中提取的数字。
 *
 * 算法（严格移植自 C# FixUnityCrcInPlace）：
 * 1. 从 fileName 提取第一个连续数字串作为 targetCrc
 * 2. 解析 UnityFS 头部，定位 blockData 起始位置（blocksInfo 之后，可能对齐16）
 * 3. 计算 blockData 区域（从 blockDataStart 到文件尾）的 CRC32
 * 4. 如果已等于 targetCrc，无需修改
 * 5. 否则：
 *    a. 计算补丁值：reverse_crc32(targetCrc) ^ (actualCrc ^ 0xFFFFFFFF)
 *       其中 reverse_crc32 是 CRC32 的 32 步逆向运算
 *    b. 更新 UnityFS header 的 size 字段（+4）
 *    c. 在 blocksInfo 中把旧 blockDataSize 替换为 blockDataSize+4
 *    d. 追加 4 字节补丁（小端）到文件末尾
 *
 * @param unityFs   UnityFS ArrayBuffer（会被修改并返回新的 ArrayBuffer）
 * @param fileName  原始 KH 文件名（用于提取目标 CRC32）
 * @returns         可能追加了 4 字节补丁的 UnityFS ArrayBuffer
 */
export function fixUnityCrcInPlace(unityFs: ArrayBuffer, fileName: string): ArrayBuffer {
  // 1. 从文件名提取目标 CRC32
  const match = fileName.match(/\d+/);
  if (!match) {
    throw new Error(`fixUnityCrc: cannot parse target CRC from file name '${fileName}'`);
  }
  const targetCrc = match[0] >>> 0; // uint32

  let data = new Uint8Array(unityFs.slice(0));

  // 2. 找到 UnityFS magic offset（标准 UnityFS\0 = 8 字节）
  const standardMagic = new TextEncoder().encode('UnityFS\0');
  const magicOffset = indexOfBytes(data, 0, standardMagic);
  if (magicOffset === -1) {
    throw new Error('fixUnityCrc: not a standard UnityFS bundle');
  }

  // 3. 解析头部（与 C# ParseBundleHeader 一致）
  // magic(magicLen) + version(4) + unityVersion\0 + unityReversion\0 + size(8) + blocksInfoSize(4) + ?(4) + flags(4)
  const version = new DataView(data.buffer, data.byteOffset + magicOffset + standardMagic.length, 4).getUint32(0, false);
  let p = magicOffset + standardMagic.length + 4; // skip magic + version
  // find null terminator for unityVersion
  while (data[p] !== 0) p++; p++; // unityVersion + \0
  while (data[p] !== 0) p++; p++; // unityReversion + \0
  const sizeOffset = p;
  const recordedFileSize = Number(new DataView(data.buffer, data.byteOffset + p, 8).getBigUint64(0, false));
  p += 8;
  const blocksInfoSize = new DataView(data.buffer, data.byteOffset + p, 4).getUint32(0, false);
  p += 4;
  p += 4; // uncompressedBlocksInfoSize (skip)
  const flags = new DataView(data.buffer, data.byteOffset + p, 4).getUint32(0, false);
  p += 4;
  const headerEnd = p;

  // blocksInfo 起始位置：version >= 7 时 header 需要 16 字节对齐
  // （与 BundleFile.readBlocksInfoAndDirectory 中的 r.align(16) 一致）
  let blocksInfoStart = headerEnd;
  if (version >= 7) blocksInfoStart = align16(blocksInfoStart);

  // blockData 起始位置：blocksInfo 之后，可能对齐16
  let blockDataStart = blocksInfoStart + blocksInfoSize;
  if ((flags & 0x80) === 0 && (flags & 0x200) !== 0) {
    blockDataStart = align16(blockDataStart);
  }

  if (blockDataStart > data.length) {
    throw new Error('fixUnityCrc: blockData starts past end of file');
  }

  // 4. 计算 blockData 区域 CRC32（从 blockDataStart 到 recordedFileSize）
  // 使用 recordedFileSize 而非 data.length，因为解密后的 UnityFS 文件末尾可能包含
  // magicDiff 字节零 padding（来自 KH 加密时的 Array.Resize）。这些 padding 不属于
  // blockData，不应计入 CRC32 计算范围。
  const blockDataLen = Math.min(data.length, recordedFileSize) - blockDataStart;
  const actualCrc = computeCrc32(data, blockDataStart, blockDataLen);

  // 5. 如果已匹配，无需修改
  if (actualCrc === targetCrc) {
    return data.buffer;
  }

  // 6. 计算 4 字节补丁
  // C# 逻辑: num12 = targetCrc ^ 0xFFFFFFFF; 然后 32 步逆向 CRC32; 最后 num12 ^ (actualCrc ^ 0xFFFFFFFF)
  let num12 = (targetCrc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < 32; i++) {
    if (num12 & 0x80000000) {
      num12 = ((num12 ^ 0xedb88320) << 1) | 1;
    } else {
      num12 = num12 << 1;
    }
    num12 = num12 >>> 0;
  }
  const patch = (num12 ^ (actualCrc ^ 0xffffffff)) >>> 0;

  // 7. 更新 UnityFS header 的 size 字段（+4）
  new DataView(data.buffer, data.byteOffset + sizeOffset, 8)
    .setBigUint64(0, BigInt(recordedFileSize + 4), false);

  // 8. 在 blocksInfo 中把旧 blockDataSize 替换为 blockDataSize+4
  // C# 在 blocksInfo 区域（headerEnd 到 blockDataStart）搜索旧 blockDataSize 的 BE 字节，替换为新值
  const oldSizeBytes = new Uint8Array(4);
  new DataView(oldSizeBytes.buffer).setUint32(0, blockDataLen, false);
  const newSizeBytes = new Uint8Array(4);
  new DataView(newSizeBytes.buffer).setUint32(0, blockDataLen + 4, false);
  for (let j = blocksInfoStart; j <= blockDataStart - 4; j++) {
    let match2 = true;
    for (let k = 0; k < 4; k++) {
      if (data[j + k] !== oldSizeBytes[k]) { match2 = false; break; }
    }
    if (match2) {
      data[j] = newSizeBytes[0];
      data[j + 1] = newSizeBytes[1];
      data[j + 2] = newSizeBytes[2];
      data[j + 3] = newSizeBytes[3];
    }
  }

  // 9. 追加 4 字节补丁（小端，与 C# BitConverter.GetBytes 一致）
  const result = new Uint8Array(data.length + 4);
  result.set(data, 0);
  new DataView(result.buffer, result.byteOffset + data.length, 4).setUint32(0, patch, true);

  // 10. 验证新 CRC32（范围与步骤 4 一致，加上 4 字节补丁）
  const verifyCrc = computeCrc32(result, blockDataStart, blockDataLen + 4);
  if (verifyCrc !== targetCrc) {
    throw new Error(`fixUnityCrc: CRC repair failed. expected=0x${targetCrc.toString(16)} actual=0x${verifyCrc.toString(16)}`);
  }

  return result.buffer;
}
