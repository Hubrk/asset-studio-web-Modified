import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { loadAssetBundle, AssetType, TextureFormat } from '@arkntools/unity-js';
import { encodeTextureWithMips } from '../textureEncoder';

const SAMPLE =
  'C:/Users/34072/Desktop/纯立绘/A纯立绘/「和服」夕日红_pvp90176/3569823446解密.assetbundle';
const exists = fs.existsSync(SAMPLE);

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

describe.skipIf(!exists)('texture re-encode size: original format vs RGBA32', () => {
  it('original format encodes near original size; RGBA32 is far larger', async () => {
    const buf = fs.readFileSync(SAMPLE);
    const bundle = await loadAssetBundle(toArrayBuffer(buf));

    // 找到第一个 Texture2D
    const objMap = (bundle as any).objectMap as Map<bigint, any>;
    let tex: any = null;
    for (const obj of objMap.values()) {
      if (obj?.type === AssetType.Texture2D) {
        tex = obj;
        break;
      }
    }
    expect(tex, 'Texture2D found').toBeTruthy();
    const w = tex.width as number;
    const h = tex.height as number;
    const fmt = tex.textureFormat as TextureFormat;
    const origSize = (tex.streamData?.size ?? tex.dataSize) as number;
    // eslint-disable-next-line no-console
    console.log(`[tex] ${w}x${h} fmt=${TextureFormat[fmt]} origStreamData=${origSize}`);

    // 编码大小只取决于 w*h*格式，与像素内容无关，用占位 RGBA 即可
    const rgba = new Uint8Array(w * h * 4);
    const origEnc = encodeTextureWithMips(rgba, w, h, fmt, origSize);
    const rgbaEnc = encodeTextureWithMips(rgba, w, h, TextureFormat.RGBA32, origSize);

    // eslint-disable-next-line no-console
    console.log(`[enc] originalFmt=${origEnc.length} RGBA32=${rgbaEnc.length} ratio=${(rgbaEnc.length / origEnc.length).toFixed(2)}x`);

    // 原格式编码应接近原 streamData 大小（含 mip 链，允许 ±50% 容差）
    expect(origEnc.length).toBeLessThan(Math.ceil(origSize * 1.5));
    expect(origEnc.length).toBeGreaterThan(Math.floor(origSize * 0.5));
    // RGBA32（旧默认）应远大于原格式 —— 这就是"文件大小差别大"的主因
    expect(rgbaEnc.length).toBeGreaterThan(origEnc.length * 3);
  });
});
