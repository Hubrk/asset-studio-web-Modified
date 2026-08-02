import { existsSync, readFileSync } from 'node:fs';
import { decompressBlock } from 'lz4js';
import { describe, expect, it } from 'vitest';
import { decryptKhBundle, isKhBundle, isUnityFs, splitKhBundle } from '../khDecrypt';
import { encryptKhBundle, encryptUnityFsToKh, encryptUnityFsToKhFresh } from '../khEncrypt';

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

describe('外部修改后文件大小变化的加密测试', () => {
  // 原始 KH 文件（游戏源文件，用于获取 meta）
  const origKhPath = 'C:\\Users\\34072\\Desktop\\新建文件夹\\1756755998..assetbundle';
  // 外部工具修改后的 UnityFS 文件（文件大小已变化）
  const modifiedFsPath = 'C:\\Users\\34072\\Desktop\\新建文件夹\\decrypted_2026-07-22_145122\\1756755998..assetbundle';
  // 解密后未修改的 UnityFS 文件（用于验证 round-trip）
  const decrPath = 'C:\\Users\\34072\\Desktop\\新建文件夹\\decr8\\1756755998..assetbundle';

  it('外部修改后的 UnityFS 签名正确', () => {
    if (!existsSync(modifiedFsPath)) { console.warn('skip'); return; }
    const modified = readFileSync(modifiedFsPath).buffer;
    expect(isUnityFs(modified)).toBe(true);
  });

  it('round-trip 加密修改后的文件 → size 字段正确更新', () => {
    if (!existsSync(origKhPath) || !existsSync(modifiedFsPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const modified = readFileSync(modifiedFsPath).buffer;
    const meta = splitKhBundle(original);

    // round-trip 加密
    const encrypted = encryptKhBundle(modified, meta);
    const encView = new Uint8Array(encrypted);

    // 验证 size 字段（在 header 中 nullPos+23 位置）
    const nullPos = meta.header.indexOf(0);
    const sizeOffsetInHeader = nullPos + 23;
    const sizeInHeader = new DataView(encView.buffer, encView.byteOffset + sizeOffsetInHeader, 8).getBigUint64(0, false);
    const actualSize = BigInt(encrypted.byteLength);

    expect(sizeInHeader).toBe(actualSize);
  });

  it('round-trip 加密修改后的文件 → 解密后与修改后文件一致', () => {
    if (!existsSync(origKhPath) || !existsSync(modifiedFsPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    const modified = readFileSync(modifiedFsPath).buffer;
    const meta = splitKhBundle(original);

    const encrypted = encryptKhBundle(modified, meta);
    const decrypted = decryptKhBundle(encrypted);

    expect(buffersEqual(decrypted, modified)).toBe(true);
  });

  it('fresh 加密修改后的文件 → size 字段正确', () => {
    if (!existsSync(modifiedFsPath)) { console.warn('skip'); return; }
    const modified = readFileSync(modifiedFsPath).buffer;

    const encrypted = encryptUnityFsToKhFresh(modified, 'UnityKHFS');
    const encView = new Uint8Array(encrypted);

    // fresh 加密的 header nullPos = 9 (UnityKHFS)
    const sizeOffsetInHeader = 9 + 23;
    const sizeInHeader = new DataView(encView.buffer, encView.byteOffset + sizeOffsetInHeader, 8).getBigUint64(0, false);
    const actualSize = BigInt(encrypted.byteLength);

    expect(sizeInHeader).toBe(actualSize);
  });

  it('fresh 加密修改后的文件 → block 8对齐 + trailing 00 00 + node数据保持', { timeout: 30000 }, () => {
    if (!existsSync(modifiedFsPath)) { console.warn('skip'); return; }
    const modified = readFileSync(modifiedFsPath).buffer;
    const encrypted = encryptUnityFsToKhFresh(modified, 'UnityKHFS');
    const decrypted = decryptKhBundle(encrypted);
    const decT = new Uint8Array(decrypted);
    const modT = new Uint8Array(modified);

    // 解密后的 s 块
    const decSView = new DataView(decT.buffer, decT.byteOffset + 38, 12);
    const decC = decSView.getUint32(0, false);
    const decUnc = decSView.getUint32(4, false);
    const decFlags = decSView.getUint32(8, false);
    const decCompression = decFlags & 0x3f;

    // 修改后文件的 s 块
    const modSView = new DataView(modT.buffer, modT.byteOffset + 38, 12);
    const modC = modSView.getUint32(0, false);
    const modUnc = modSView.getUint32(4, false);
    const modFlags = modSView.getUint32(8, false);
    const modCompression = modFlags & 0x3f;

    // fresh 加密保持源文件的 compression 类型不变（不强制重新压缩）
    expect(decCompression).toBe(modCompression);
    expect(decC).toBe(modC);
    expect(decUnc).toBe(modUnc);
    expect(decFlags).toBe(modFlags);

    // 解析修改后文件的 block size（从 blocksInfo 中读取）
    const modBlockCount = new DataView(modT.buffer, modT.byteOffset + 64 + 16, 4).getUint32(0, false);
    const modBlockSize = new DataView(modT.buffer, modT.byteOffset + 64 + 20, 4).getUint32(0, false);

    // 解析解密后文件的 block size
    const decBlockCount = new DataView(decT.buffer, decT.byteOffset + 64 + 16, 4).getUint32(0, false);
    const decBlockSize = new DataView(decT.buffer, decT.byteOffset + 64 + 20, 4).getUint32(0, false);

    expect(decBlockCount).toBe(modBlockCount);

    // block size 应该是 8 字节对齐的
    expect(decBlockSize % 8).toBe(0);
    // 如果原始 block size 不是 8 对齐的，解密后的 block size 会更大（添加了 padding）
    expect(decBlockSize).toBeGreaterThanOrEqual(modBlockSize);
    expect(decBlockSize - modBlockSize).toBeLessThan(8);

    // node 数据区域应保持不变（block data 的前 modBlockSize 字节）
    const dataStart = 64 + decC;
    const decNodeData = decT.slice(dataStart, dataStart + modBlockSize);
    const modNodeData = modT.slice(dataStart, dataStart + modBlockSize);
    expect(decNodeData.length).toBe(modNodeData.length);
    for (let i = 0; i < modNodeData.length; i++) {
      expect(decNodeData[i]).toBe(modNodeData[i]);
    }

    // padding 区域应是零填充
    const paddingLen = decBlockSize - modBlockSize;
    if (paddingLen > 0) {
      const padding = decT.slice(dataStart + modBlockSize, dataStart + modBlockSize + paddingLen);
      for (let i = 0; i < padding.length; i++) {
        expect(padding[i]).toBe(0);
      }
    }

    // 文件末尾应有 2 字节 trailing 00 00
    const trailingStart = dataStart + decBlockSize;
    expect(decT.length).toBeGreaterThanOrEqual(trailingStart + 2);
    expect(decT[decT.length - 2]).toBe(0);
    expect(decT[decT.length - 1]).toBe(0);
  });

  // 原始未修改文件的 round-trip 仍然字节级一致（不回归）
  it('原始未修改文件 round-trip 仍然字节级一致', () => {
    if (!existsSync(origKhPath)) { console.warn('skip'); return; }
    const original = readFileSync(origKhPath).buffer;
    // 直接用原始 KH 文件解密再加密，验证字节级一致
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);

    const encrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(encrypted, original)).toBe(true);
  });
});
