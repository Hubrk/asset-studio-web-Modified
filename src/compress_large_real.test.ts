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

  // 1MB 真实（高度可压缩，因为是 Unity 资源二进制）原始数据
  const raw = new Uint8Array(await bundle.rebuild(0)); // 1,011,960 bytes
  console.log('ORIG uncompressed bytes :', raw.length);

  // 拼接成 ~8MB 真实可压缩缓冲，复现用户改 RGBA32 后的单块 8.46MB 场景
  const reps = 8;
  const big = new Uint8Array(raw.length * reps);
  for (let i = 0; i < reps; i++) big.set(raw, i * raw.length);
  console.log('BIG buffer bytes        :', big.length);

  const comp = compressLz4(big);
  fs.writeFileSync('research/_big_lz4.bin', Buffer.from(comp));
  fs.writeFileSync('research/_big_origsize.txt', String(big.length));
  console.log('compressLz4 output      :', comp.length, 'bytes');
}

it('compressLz4 on large real compressible buffer', { timeout: 120000 }, async () => {
  if (!fs.existsSync(ORIG)) {
    console.log('SKIP: sample missing');
    return;
  }
  await main();
});
