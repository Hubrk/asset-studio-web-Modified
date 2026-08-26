import * as fs from 'node:fs';
import { it } from 'vitest';
import { loadAssetBundle, TextureFormat } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '@/utils/khDecrypt';

const ORIG =
  'C:/Users/34072/Desktop/胜利改牛逼/90248迪达拉[秽土转生]/帧动画/2137173546.assetbundle';

it('probe texture objects', { timeout: 120000 }, async () => {
  if (!fs.existsSync(ORIG)) { console.log('SKIP'); return; }
  const buf = fs.readFileSync(ORIG);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const unityFs = isKhBundle(ab) ? decryptKhBundle(ab) : ab;
  const bundle = await loadAssetBundle(unityFs.slice(0));
  console.log('blockInfos:', (bundle as any).blockInfos?.length);
  console.log('nodes:', (bundle as any).nodes?.length, 'files:', (bundle as any).files?.length);
  const objs = (bundle as any).objects as any[];
  console.log('total objects:', objs.length);
  for (const obj of objs) {
    if (obj.type === 'Texture2D' || obj.type === 28) {
      const t = obj as any;
      console.log('--- Texture2D ---');
      console.log('  pathId      :', (t as any).pathId?.toString?.());
      console.log('  name        :', (t as any).name);
      console.log('  width/height:', t.width, t.height);
      console.log('  format      :', TextureFormat[t.textureFormat], `(`, t.textureFormat, `)`);
      console.log('  dataSize    :', t.dataSize);
      console.log('  streamData  :', JSON.stringify(t.streamData));
    }
  }
});
