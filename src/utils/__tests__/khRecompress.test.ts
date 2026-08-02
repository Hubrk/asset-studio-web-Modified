import { existsSync, readFileSync } from 'node:fs';
import { decompressBlock } from 'lz4js';
import { describe, expect, it } from 'vitest';
import { decryptKhBundle, isUnityFs, splitKhBundle } from '../khDecrypt';
import { encryptKhBundle } from '../khEncrypt';

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

/**
 * Read the 12-byte s block from a KH header at the expected offset.
 * Returns { c, unc, flags, compression }.
 */
function readKhHeaderS(buf: ArrayBuffer) {
  const t = new Uint8Array(buf);
  let nullPos = -1;
  for (let i = 0; i < Math.min(t.length, 12); i++) {
    if (t[i] === 0) { nullPos = i; break; }
  }
  const sOffset = nullPos + 31;
  const view = new DataView(t.buffer, t.byteOffset + sOffset, 12);
  const c = view.getUint32(0, false);
  const unc = view.getUint32(4, false);
  const flags = view.getUint32(8, false);
  return { c, unc, flags, compression: flags & 0x3f };
}

/**
 * Read the 12-byte s block from a decrypted UnityFS buffer (offset 38-49).
 */
function readUnityFsS(buf: ArrayBuffer) {
  const t = new Uint8Array(buf);
  const view = new DataView(t.buffer, t.byteOffset + 38, 12);
  const c = view.getUint32(0, false);
  const unc = view.getUint32(4, false);
  const flags = view.getUint32(8, false);
  return { c, unc, flags, compression: flags & 0x3f };
}

/**
 * Simulate UABE's behavior of saving blocksInfo as uncompressed:
 * 1. Decrypt the original KH bundle to UnityFS
 * 2. Decompress the LZ4_HC blocksInfo
 * 3. Replace s: c = uncompressedSize, flags compression = 0 (none)
 * 4. Replace blocksInfo with the uncompressed version
 * Returns a UnityFS buffer that looks like what UABE would produce.
 */
function simulateUabeModify(originalKh: ArrayBuffer): ArrayBuffer {
  const decrypted = decryptKhBundle(originalKh);
  const t = new Uint8Array(decrypted);
  const s = readUnityFsS(decrypted);

  if (s.compression === 0) {
    // Already uncompressed, nothing to simulate.
    return decrypted;
  }

  // Decompress blocksInfo (offset 64, c bytes) using lz4js.
  const compressedBlocksInfo = t.slice(64, 64 + s.c);
  const uncBlocksInfo = new Uint8Array(s.unc);
  const decSize = decompressBlock(compressedBlocksInfo, uncBlocksInfo, 0, compressedBlocksInfo.length, 0);
  if (decSize !== s.unc) {
    throw new Error(`decompress failed: got ${decSize}, expected ${s.unc}`);
  }

  // Build modified UnityFS: same header but s changed to uncompressed,
  // and blocksInfo replaced with uncompressed version.
  // New s: c = unc (uncompressed size), unc = unc, flags = (flags & ~0x3f) | 0
  const newC = s.unc;
  const newFlags = (s.flags & ~0x3f) | 0;
  const tail = t.slice(64 + s.c); // data blocks, unchanged

  const result = new Uint8Array(64 + newC + tail.length);
  // Copy header (bytes 0-63: "UnityFS" + o + s + padding)
  result.set(t.slice(0, 38), 0); // magic + o
  // Write new s
  const sView = new DataView(result.buffer, 38, 12);
  sView.setUint32(0, newC, false);
  sView.setUint32(4, s.unc, false);
  sView.setUint32(8, newFlags, false);
  // padding (14 bytes zero) — already zero from initialization
  // Write uncompressed blocksInfo
  result.set(uncBlocksInfo, 64);
  // Write tail
  result.set(tail, 64 + newC);

  return result.buffer;
}

describe('blocksInfo 重新压缩测试（UABE 修改后场景）', () => {
  // 4087659059: UnityKHFS, c=88, unc=153, flags=0x243 (LZ4_HC)
  const origKhPath = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\4087659059.assetbundle';
  // 110943700: UnityKHFS, c=100, unc=173, flags=0x243 (LZ4_HC)
  const origKhPath2 = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('原始 KH 文件使用 LZ4_HC 压缩', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const s = readKhHeaderS(original);
    expect(s.compression).toBe(3); // LZ4_HC
    expect(s.c).toBe(88);
    expect(s.unc).toBe(153);
  });

  it('round-trip（未修改）仍然字节级一致', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);
    const encrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(encrypted, original)).toBe(true);
  });

  it('模拟 UABE 修改后：blocksInfo 变为未压缩', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const modified = simulateUabeModify(original);
    const s = readUnityFsS(modified);
    // UABE 会把 blocksInfo 改为未压缩
    expect(s.compression).toBe(0); // none
    expect(s.c).toBe(153); // c = uncompressed size
    expect(s.unc).toBe(153);
  });

  it('加密修改后的文件：KH header 的 compression 恢复为 LZ4_HC', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const meta = splitKhBundle(original);
    const modified = simulateUabeModify(original);

    const encrypted = encryptKhBundle(modified, meta);
    const s = readKhHeaderS(encrypted);

    // 加密后，compression 应该恢复为 LZ4_HC (3)，和原始 KH meta 一致
    expect(s.compression).toBe(3); // LZ4_HC
    // c 应该是压缩后大小（小于未压缩大小 153）
    expect(s.c).toBeLessThan(153);
    expect(s.c).toBeGreaterThan(0);
    // unc 应该是未压缩大小 153
    expect(s.unc).toBe(153);
  });

  it('加密修改后的文件：解密后 blocksInfo 能被 LZ4 正确解压', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const meta = splitKhBundle(original);
    const modified = simulateUabeModify(original);

    const encrypted = encryptKhBundle(modified, meta);
    const decrypted = decryptKhBundle(encrypted);
    const s = readUnityFsS(decrypted);

    // 解密后的 UnityFS 应该有 LZ4_HC 压缩的 blocksInfo
    expect(s.compression).toBe(3); // LZ4_HC
    expect(s.unc).toBe(153);

    // 解压 blocksInfo 验证
    const t = new Uint8Array(decrypted);
    const compressedBlocksInfo = t.slice(64, 64 + s.c);
    const uncDst = new Uint8Array(s.unc);
    const decSize = decompressBlock(compressedBlocksInfo, uncDst, 0, compressedBlocksInfo.length, 0);
    expect(decSize).toBe(s.unc);

    // 解压后的 blocksInfo 应该和模拟修改时的未压缩 blocksInfo 内容一致
    const modifiedS = readUnityFsS(modified);
    const modifiedBlocksInfo = new Uint8Array(modified).slice(64, 64 + modifiedS.c);
    for (let i = 0; i < s.unc; i++) {
      expect(uncDst[i]).toBe(modifiedBlocksInfo[i]);
    }
  });

  it('加密修改后的文件：size 字段正确更新', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const meta = splitKhBundle(original);
    const modified = simulateUabeModify(original);

    const encrypted = encryptKhBundle(modified, meta);
    const t = new Uint8Array(encrypted);

    // size 字段在 header 中 nullPos+23 位置
    const nullPos = meta.header.indexOf(0);
    const sizeOffset = nullPos + 23;
    const sizeInHeader = new DataView(t.buffer, t.byteOffset + sizeOffset, 8).getBigUint64(0, false);
    expect(sizeInHeader).toBe(BigInt(encrypted.byteLength));
  });

  // 第二个文件（110943700）的相同测试
  it('第二个文件 (110943700) round-trip 字节级一致', () => {
    if (!existsSync(origKhPath2)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath2).buffer;
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);
    const encrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(encrypted, original)).toBe(true);
  });

  it('第二个文件 (110943700) 加密修改后：compression 恢复为 LZ4_HC', () => {
    if (!existsSync(origKhPath2)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath2).buffer;
    const meta = splitKhBundle(original);
    const modified = simulateUabeModify(original);

    const encrypted = encryptKhBundle(modified, meta);
    const s = readKhHeaderS(encrypted);

    expect(s.compression).toBe(3); // LZ4_HC
    expect(s.c).toBeLessThan(173);
    expect(s.unc).toBe(173);
  });
});
