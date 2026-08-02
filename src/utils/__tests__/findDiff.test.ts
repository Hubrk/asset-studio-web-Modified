import fs from 'fs';
import { describe, it } from 'vitest';
import { splitKhBundle } from '../khDecrypt';
import { encryptUnityFsToKh } from '../khEncrypt';

describe('find 8 byte diff', () => {
  it('show diff at 0x57', () => {
    const testDir = 'C:/Users/34072/Desktop/测试';
    const xg110 = fs.readFileSync(`${testDir}/xg110`);
    const stdEnc = fs.readFileSync(`${testDir}/110943700xg`);
    const origEnc = fs.readFileSync(`${testDir}/110943700.assetbundle`);
    const meta = splitKhBundle(origEnc.buffer.slice(origEnc.byteOffset, origEnc.byteOffset + origEnc.byteLength));

    const webEnc = encryptUnityFsToKh(
      xg110.buffer.slice(xg110.byteOffset, xg110.byteOffset + xg110.byteLength),
      meta,
      'UnityKHFS',
      '110943700.assetbundle',
    );

    const webBuf = new Uint8Array(webEnc);
    const stdBuf = new Uint8Array(stdEnc);

    console.log('=== 差异位置 ===');
    for (let i = 0; i < stdEnc.length; i++) {
      if (webBuf[i] !== stdBuf[i]) {
        console.log(`0x${i.toString(16)}: web=${webBuf[i].toString(16).padStart(2, '0')} std=${stdBuf[i].toString(16).padStart(2, '0')}`);
      }
    }

    // 显示 0x50-0x70 区域
    console.log('\n=== 0x50-0x70 区域 ===');
    for (let i = 0x50; i < 0x70; i += 16) {
      let webLine = '';
      let stdLine = '';
      for (let j = 0; j < 16 && i + j < webBuf.length; j++) {
        webLine += webBuf[i + j].toString(16).padStart(2, '0') + ' ';
        stdLine += stdBuf[i + j].toString(16).padStart(2, '0') + ' ';
      }
      console.log(`web ${i.toString(16).padStart(2, '0')}: ${webLine}`);
      console.log(`std ${i.toString(16).padStart(2, '0')}: ${stdLine}`);
    }
  });
});
