import * as fs from 'node:fs';
import { it } from 'vitest';
import { loadAssetBundle, TextureFormat, AssetType } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '@/utils/khDecrypt';
import { encodeTextureWithMips, flipVerticalRgba, bleedAlpha } from '@/utils/textureEncoder';

const ORIG =
  'C:/Users/34072/Desktop/胜利改牛逼/90248迪达拉[秽土转生]/帧动画/2137173546.assetbundle';
const OUT = 'research/_repro_mod_rgb32.bin';

async function main() {
  const buf = fs.readFileSync(ORIG);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const unityFs = isKhBundle(ab) ? decryptKhBundle(ab) : ab;
  const bundle: any = await loadAssetBundle(unityFs.slice(0));

  // locate the Texture2D
  const tex: any = (bundle.objects as any[]).find(o => o.type === AssetType.Texture2D || o.type === 'Texture2D');
  if (!tex) throw new Error('no texture found');
  const w = tex.width, h = tex.height;
  console.log('texture:', tex.name, w, 'x', h, 'origFmt=', TextureFormat[tex.textureFormat]);

  // Build RGBA32 test image (a gradient — realistic, compressible-ish)
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x >> 3) & 0xff;
      rgba[i + 1] = (y >> 3) & 0xff;
      rgba[i + 2] = ((x + y) >> 3) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  const flipped = flipVerticalRgba(rgba, w, h);
  const bled = bleedAlpha(flipped, w, h);

  // user selected RGBA32, no mips
  const fmt: TextureFormat = TextureFormat.RGBA32;
  const finalEncoded = encodeTextureWithMips(bled, w, h, fmt, 0);
  console.log('finalEncoded length (RGBA32):', finalEncoded.length, '(expect 8388608)');

  // ---- replicate modifyTexture2D streamData branch ----
  Object.defineProperty(tex, 'textureFormat', { value: fmt, writable: true, configurable: true });
  (tex as any)._modifiedTextureFormat = fmt;
  const sPath = tex.streamData.path.split('/').pop()!;
  const nodeIndex = bundle.nodes.findIndex((n: any) => n.path === sPath);
  if (nodeIndex === -1) throw new Error(`cannot find stream node ${sPath}`);
  const offset = tex.streamData.offset;
  const oldSize = tex.streamData.size;

  if (finalEncoded.length > oldSize) {
    const oldNodeData = new Uint8Array(bundle.files[nodeIndex]);
    const extraBytes = finalEncoded.length - oldSize;
    const tailStart = offset + oldSize;
    const tailData = tailStart < oldNodeData.length ? oldNodeData.slice(tailStart) : new Uint8Array(0);
    const newNodeData = new Uint8Array(oldNodeData.length + extraBytes);
    newNodeData.set(oldNodeData.slice(0, offset), 0);
    newNodeData.set(finalEncoded, offset);
    newNodeData.set(tailData, offset + finalEncoded.length);
    bundle.files[nodeIndex] = newNodeData.buffer;
  } else {
    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    nodeData.set(finalEncoded, offset);
  }
  Object.defineProperty(tex.streamData, 'size', { value: finalEncoded.length, writable: true, configurable: true });

  const objInfo = (tex as any).__info;
  const objBytesStart = objInfo.bytesStart;
  const objBytesSize = objInfo.bytesSize;
  const { ArrayBufferWriter } = await import('@arkntools/unity-js') as any;
  const objWriter = new ArrayBufferWriter(objBytesSize);
  tex.serialize(objWriter);
  const serialized = new Uint8Array(objWriter.getBuffer().slice(0, objWriter.position));
  const assetPath = objInfo.asset.path;
  const assetNodeIndex = bundle.nodes.findIndex((n: any) => n.path === assetPath);
  if (assetNodeIndex === -1) throw new Error(`cannot find asset node ${assetPath}`);
  const assetFileData = new Uint8Array(bundle.files[assetNodeIndex]);
  assetFileData.set(serialized, objBytesStart);

  // ---- export with LZ4_HC (compressionMode = 3) ----
  const rebuilt: ArrayBuffer = bundle.rebuild(3);
  fs.writeFileSync(OUT, Buffer.from(rebuilt.slice(0)));
  console.log('rebuild(3) output bytes:', rebuilt.byteLength);
}

it('faithful reproduce: modify to RGBA32 + LZ4_HC export', { timeout: 120000 }, async () => {
  if (!fs.existsSync(ORIG)) { console.log('SKIP: sample missing'); return; }
  await main();
});
