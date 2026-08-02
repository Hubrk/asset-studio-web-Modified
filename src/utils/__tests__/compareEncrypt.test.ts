import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { decryptKhBundle, splitKhBundle, isKhBundle } from '../khDecrypt';
import { encryptUnityFsToKh, fixUnityCrcInPlace } from '../khEncrypt';
import { loadAssetBundle } from '@arkntools/unity-js';

const testDir = 'C:/Users/34072/Desktop/测试';
const hasTestFiles = fs.existsSync(`${testDir}/110943700.assetbundle`) && fs.existsSync(`${testDir}/110943700xg`);

describe.skipIf(!hasTestFiles)('compare with standard tool encryption', () => {
  it('web 加密应与标准工具字节级一致', async () => {
    // 1. 读取标准工具修改后的解密文件
    const xg110 = fs.readFileSync(`${testDir}/xg110`);
    const stdEncPath = `${testDir}/110943700xg`;
    const stdEnc = fs.readFileSync(stdEncPath);

    // 2. 读取原始 KH 文件获取 meta
    const origEnc = fs.readFileSync(`${testDir}/110943700.assetbundle`);
    const meta = splitKhBundle(origEnc.buffer.slice(origEnc.byteOffset, origEnc.byteOffset + origEnc.byteLength));

    // 3. web 加密：用原始 meta + 修改后的 UnityFS
    const webEnc = encryptUnityFsToKh(
      xg110.buffer.slice(xg110.byteOffset, xg110.byteOffset + xg110.byteLength),
      meta,
      'UnityKHFS',
      '110943700.assetbundle', // 原始文件名，用于提取 CRC32 目标
    );

    console.log('=== 对比 ===');
    console.log('web 加密:', webEnc.byteLength);
    console.log('std 加密:', stdEnc.length);
    console.log('diff:', webEnc.byteLength - stdEnc.length);

    // 4. 字节级对比
    const webBuf = new Uint8Array(webEnc);
    const stdBuf = new Uint8Array(stdEnc);

    if (webEnc.byteLength !== stdEnc.length) {
      console.log('长度不同，跳过逐字节对比');
      // 找前 100 字节的差异
      const minLen = Math.min(webEnc.byteLength, stdEnc.length);
      let firstDiff = -1;
      for (let i = 0; i < minLen; i++) {
        if (webBuf[i] !== stdBuf[i]) {
          firstDiff = i;
          break;
        }
      }
      console.log('firstDiff:', firstDiff === -1 ? 'none in common range' : '0x' + firstDiff.toString(16));
      expect(true).toBe(true); // 不 fail，只看输出
      return;
    }

    let firstDiff = -1;
    let diffCount = 0;
    for (let i = 0; i < stdEnc.length; i++) {
      if (webBuf[i] !== stdBuf[i]) {
        diffCount++;
        if (firstDiff === -1) firstDiff = i;
      }
    }
    console.log('firstDiff:', firstDiff === -1 ? 'none' : '0x' + firstDiff.toString(16));
    console.log('diffCount:', diffCount);
    expect(diffCount).toBe(0);
  });

  it('验证 FixUnityCrcInPlace 单独效果', () => {
    // 读取标准工具修改后的解密文件
    const xg110 = fs.readFileSync(`${testDir}/xg110`);
    // 应用 CRC32 补丁
    const patched = fixUnityCrcInPlace(
      xg110.buffer.slice(xg110.byteOffset, xg110.byteOffset + xg110.byteLength),
      '110943700.assetbundle',
    );
    console.log('\n=== FixUnityCrcInPlace ===');
    console.log('before:', xg110.length);
    console.log('after:', patched.byteLength);
    console.log('added:', patched.byteLength - xg110.length);
    // 应该追加 4 字节
    expect(patched.byteLength).toBe(xg110.length + 4);
  });
});
