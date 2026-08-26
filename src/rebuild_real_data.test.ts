import * as fs from 'node:fs';
import { it } from 'vitest';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '@/utils/khDecrypt';
import { compressLz4 } from '@arkntools/unity-js';

const ORIG =
  'C:/Users/34072/Desktop/胜利改牛逼/90248迪达拉[秽土转生]/帧动画/2137173546.assetbundle';

async function main() {
  const buf = fs.readFileSync(ORIG);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const unityFs = isKhBundle(ab) ? decryptKhBundle(ab) : ab;
  const bundle = await loadAssetBundle(unityFs.slice(0));

  // 1) 完整解锁压后的原始数据（用于隔离测试 compressLz4）
  const raw = await bundle.rebuild(0); // 未压缩态 = 全部原始字节
  fs.writeFileSync('research/_orig_uncompressed.bin', Buffer.from(raw.slice(0)));

  // 2) 直接调用当前 compressLz4（隔离单元测试）
  const src = new Uint8Array(raw);
  const comp = compressLz4(src);
  fs.writeFileSync('research/_rebuild3_compressLz4_only.bin', Buffer.from(comp));
  fs.writeFileSync('research/_rebuild3_origsize.txt', String(src.length));

  // 3) 走完整 rebuild(3) 路径（导出实际做的）
  const rebuilt = await bundle.rebuild(3);
  fs.writeFileSync('research/_rebuild3_full.bin', Buffer.from(rebuilt.slice(0)));

  console.log('ORIG uncompressed bytes :', src.length);
  console.log('compressLz4-only output :', comp.length, 'bytes');
  console.log('rebuild(3) full output  :', rebuilt.byteLength, 'bytes');
}

it('rebuild(3) on real data for strict validation', { timeout: 120000 }, async () => {
  if (!fs.existsSync(ORIG)) {
    console.log('SKIP: sample missing');
    return;
  }
  await main();
});
