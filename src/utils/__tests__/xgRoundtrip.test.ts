import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { decryptKhBundle, splitKhBundle, isKhBundle, isUnityFs } from '../khDecrypt';
import { encryptUnityFsToKh, computeCrc32 } from '../khEncrypt';
import { loadAssetBundle } from '@arkntools/unity-js';

const testDir = 'C:/Users/34072/Desktop/测试';
const srcPath = `${testDir}/110943700xg`;
const decPath = `${testDir}/110943700xg_decrypted`;
const encPath = `${testDir}/110943700xg_encrypted`;
const hasFile = fs.existsSync(srcPath);

// 游戏原始文件测试目录
const gameDir = 'C:/Users/34072/Desktop/90059宇智波佐助[万花筒写轮眼]/头像2';
const gameFiles = ['2979796588.assetbundle', '58114955.assetbundle'];

describe.skipIf(!hasFile)('110943700xg 解密→再加密 round-trip', () => {
  it('诊断 CRC32 状态', () => {
    const src = fs.readFileSync(srcPath);
    const decrypted = decryptKhBundle(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    const decBuf = Buffer.from(decrypted);

    console.log('=== 解密后 UnityFS 的 CRC32 状态 ===');
    console.log('文件大小:', decBuf.length);

    // 解析 UnityFS header
    const magicEnd = decBuf.indexOf(0, 0);
    let p = magicEnd + 1 + 4; // skip magic + version
    while (decBuf[p] !== 0) p++; p++; // unityVersion
    while (decBuf[p] !== 0) p++; p++; // unityRevision
    const sizeOffset = p;
    const recordedSize = Number(decBuf.readBigUInt64BE(p));
    p += 8;
    const blocksInfoSize = decBuf.readUInt32BE(p);
    p += 4;
    p += 4; // uncBlocksInfoSize
    const flags = decBuf.readUInt32BE(p);
    p += 4;
    const headerEnd = p;

    let blockDataStart = headerEnd + blocksInfoSize;
    if ((flags & 0x80) === 0 && (flags & 0x200) !== 0) {
      blockDataStart = (blockDataStart + 15) & ~15;
    }

    const blockDataLen = decBuf.length - blockDataStart;
    const actualCrc = computeCrc32(new Uint8Array(decBuf), blockDataStart, blockDataLen);
    const targetCrc = 110943700;

    console.log('recordedSize:', recordedSize);
    console.log('blocksInfoSize:', blocksInfoSize);
    console.log('flags:', '0x' + flags.toString(16));
    console.log('headerEnd:', headerEnd);
    console.log('blockDataStart:', blockDataStart);
    console.log('blockDataLen:', blockDataLen);
    console.log('actualCrc:', '0x' + actualCrc.toString(16), '=', actualCrc);
    console.log('targetCrc:', '0x' + targetCrc.toString(16), '=', targetCrc);
    console.log('CRC 已匹配?', actualCrc === targetCrc);

    // 检查末尾 4 字节（可能是 CRC32 补丁）
    if (decBuf.length >= 4) {
      const last4 = decBuf.slice(decBuf.length - 4);
      console.log('末尾 4 字节:', last4.toString('hex'));
    }
  });

  it('解密并保存解密文件', () => {
    const src = fs.readFileSync(srcPath);
    console.log('=== 原始加密文件 ===');
    console.log('文件:', srcPath);
    console.log('大小:', src.length);

    const t = new Uint8Array(src);
    let n = -1;
    for (let i = 0; i < 12; i++) { if (t[i] === 0) { n = i; break; } }
    const sig = String.fromCharCode(...t.slice(0, n));
    console.log('magic:', JSON.stringify(sig));

    expect(isKhBundle(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength))).toBe(true);

    const decrypted = decryptKhBundle(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    console.log('\n=== 解密后 ===');
    console.log('大小:', decrypted.byteLength);
    console.log('isUnityFs:', isUnityFs(decrypted));
    expect(isUnityFs(decrypted)).toBe(true);

    fs.writeFileSync(decPath, Buffer.from(decrypted));
    console.log('已保存:', decPath);
  });

  it('再加密（含 CRC32 补丁，完整流程）并对比', () => {
    const src = fs.readFileSync(srcPath);
    const dec = fs.readFileSync(decPath);

    const meta = splitKhBundle(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    const fileName = '110943700.assetbundle';

    // 传 fileName，调用 fixUnityCrcInPlace（与 UI 实际使用路径一致）
    const reEncrypted = encryptUnityFsToKh(
      dec.buffer.slice(dec.byteOffset, dec.byteOffset + dec.byteLength),
      meta,
      meta.signature,
      fileName,
    );

    fs.writeFileSync(encPath, Buffer.from(reEncrypted));
    console.log('=== 再加密后（含 CRC32 补丁）===');
    console.log('文件:', encPath);
    console.log('大小:', reEncrypted.byteLength);
    console.log('原始大小:', src.length);
    console.log('差异:', reEncrypted.byteLength - src.length);

    const a = new Uint8Array(reEncrypted);
    const b = new Uint8Array(src);
    const minLen = Math.min(a.length, b.length);
    let firstDiff = -1;
    let diffCount = 0;
    for (let i = 0; i < minLen; i++) {
      if (a[i] !== b[i]) {
        diffCount++;
        if (firstDiff === -1) firstDiff = i;
      }
    }
    console.log('firstDiff:', firstDiff === -1 ? 'none' : '0x' + firstDiff.toString(16));
    console.log('diffCount:', diffCount);
    expect(diffCount).toBe(0);
    expect(reEncrypted.byteLength).toBe(src.length);
  });
});

// 游戏原始文件解密后必须能被 loadAssetBundle 正常加载（不能截断 blockData）
describe.skipIf(!fs.existsSync(`${gameDir}/${gameFiles[0]}`))('游戏原始文件解密后可加载', () => {
  for (const fname of gameFiles) {
    it(`${fname} 解密后能被 loadAssetBundle 加载`, async () => {
      const fpath = `${gameDir}/${fname}`;
      if (!fs.existsSync(fpath)) {
        console.log(`Skipping: file not found: ${fpath}`);
        return;
      }
      const src = fs.readFileSync(fpath);
      const decrypted = decryptKhBundle(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));

      // 解密后必须是有效的 UnityFS
      expect(isUnityFs(decrypted)).toBe(true);

      // 必须能被 loadAssetBundle 正常加载（不抛出 "End position out of boundary"）
      const bundle = await loadAssetBundle(decrypted);
      expect(bundle).toBeDefined();
      console.log(`${fname}: 解密后 ${decrypted.byteLength} 字节, 加载成功`);
    });
  }
});
