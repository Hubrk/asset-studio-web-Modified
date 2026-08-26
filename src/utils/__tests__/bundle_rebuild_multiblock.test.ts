import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle } from '@/utils/khDecrypt';
import {
  isFormatSupported,
  encodeTextureWithMips,
  flipVerticalRgba,
  bleedAlpha,
} from '@/utils/textureEncoder';

// 真实样本：90001 宇智波带土[暴怒] 帧动画 bundle。
// 关键特征：blockInfos.length = 16（全部 LZ4_HC），但 nodes.length = 2。
// 此前 rebuild() 的 blocksInfo 写入器按 nodes.length 分配空间（192B），
// 写 16 个块条目时越界抛 RangeError，导致该 bundle 的全部纹理 modifyTexture2D 失败。
const SAMPLE =
  'C:/Users/34072/Desktop/90开头奥义图+帧动画+战斗逻辑/90001漩涡鸣人/帧动画/2843738510.assetbundle';
const exists = fs.existsSync(SAMPLE);

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const rtBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

describe.skipIf(!exists)('bundle.rebuild multi-block (16 LZ4_HC blocks) regression', () => {
  it('clean rebuild is lossless + compressed (biWriter sized by block count)', async () => {
    const raw = fs.readFileSync(SAMPLE);
    const decrypted = decryptKhBundle(toArrayBuffer(raw));
    const bundle = await loadAssetBundle(decrypted.slice(0));
    const origFiles = (bundle as any).files as ArrayBuffer[];

    const rebuilt = bundle.rebuild();
    // 保留 LZ4 压缩（greedy LZ4 略弱于 Unity LZ4_HC，允许 ~1.6x 余量）
    expect(rebuilt.byteLength).toBeLessThan(Math.ceil(decrypted.byteLength * 1.6));

    const reloaded = await loadAssetBundle(rebuilt.slice(0));
    const newFiles = (reloaded as any).files as ArrayBuffer[];
    expect(newFiles.length).toBe(origFiles.length);
    for (let i = 0; i < newFiles.length; i++) {
      expect(rtBytes(new Uint8Array(newFiles[i]), new Uint8Array(origFiles[i])), `file[${i}]`).toBe(true);
    }
  });

  it('modifyTexture2D-style encode+write+rebuild does NOT throw (regression)', async () => {
    const raw = fs.readFileSync(SAMPLE);
    const decrypted = decryptKhBundle(toArrayBuffer(raw));
    const bundle = await loadAssetBundle(decrypted.slice(0));

    const pathId = BigInt('-7026226588163952160');
    const tex = (bundle as any).objectMap.get(pathId) as any;
    expect(tex, 'texture object not found').toBeTruthy();
    expect(tex.type).toBe(28); // AssetType.Texture2D

    const fmt: number = tex.textureFormat;
    expect(isFormatSupported(fmt)).toBe(true);

    // 生成 2048x2048 合成 RGBA，模拟批量导入
    const W = tex.width, H = tex.height;
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = (i * 7) & 0xff;
      rgba[i * 4 + 1] = (i * 13) & 0xff;
      rgba[i * 4 + 2] = (i * 29) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const finalEncoded = encodeTextureWithMips(
      bleedAlpha(flipVerticalRgba(rgba, W, H), W, H),
      W, H, fmt, tex.streamData?.size ?? tex.dataSize,
    );

    const { ArrayBufferWriter } = await import('@arkntools/unity-js');
    if (tex.streamData) {
      const sPath = tex.streamData.path.split('/').pop()!;
      const nodeIndex = (bundle as any).nodes.findIndex((n: any) => n.path === sPath);
      const nodeData = new Uint8Array((bundle as any).files[nodeIndex]);
      nodeData.set(finalEncoded, tex.streamData.offset);
      Object.defineProperty(tex.streamData, 'size', { value: finalEncoded.length, writable: true, configurable: true });
      const objInfo = tex.__info as any;
      const objWriter = new (ArrayBufferWriter as any)(objInfo.bytesSize);
      tex.serialize(objWriter);
      const serialized = new Uint8Array(objWriter.getBuffer().slice(0, objWriter.position));
      (new Uint8Array((bundle as any).files[(bundle as any).nodes.findIndex((n: any) => n.path === objInfo.asset.path)]))
        .set(serialized, objInfo.bytesStart);
    } else {
      tex._modifiedImageData = finalEncoded;
      const objInfo = tex.__info as any;
      const objWriter = new (ArrayBufferWriter as any)(finalEncoded.length + 1024);
      tex.serialize(objWriter);
      objInfo._modifiedData = objWriter.getBuffer().slice(0, objWriter.position);
      const asset = objInfo.asset;
      (bundle as any).files[(bundle as any).nodes.findIndex((n: any) => n.path === objInfo.asset.path)] = asset.rebuild();
    }

    // 之前此处抛 RangeError: Offset is outside the bounds of the DataView
    expect(() => bundle.rebuild()).not.toThrow();
  });
});
