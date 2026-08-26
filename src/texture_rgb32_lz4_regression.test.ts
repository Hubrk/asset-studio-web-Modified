import * as fs from 'node:fs';
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { loadAssetBundle, TextureFormat, AssetType, decodeTexture, ArrayBufferWriter } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '@/utils/khDecrypt';
import { encryptUnityFsToKh } from '@/utils/khEncrypt';
import { encodeTextureWithMips } from '@/utils/textureEncoder';
import { decompressBlock } from 'lz4js';

// 真实样本（迪达拉帧动画 bundle，KH 加密）。本地绝对路径，缺失则整文件跳过。
const ORIG =
  'C:/Users/34072/Desktop/胜利改牛逼/90248迪达拉[秽土转生]/帧动画/2137173546.assetbundle';
const FILE_NAME = '2137173546.assetbundle';
// 与样本共存的 venv python（官方 lz4 严格校验用）。缺失则由 lz4js 往返兜底。
const VENV_PY = 'C:/Users/34072/.workbuddy/binaries/python/envs/default/Scripts/python.exe';

const sampleExists = fs.existsSync(ORIG);
const d = sampleExists ? it : it.skip;

function bgraToRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = src[i + 3];
  }
  return out;
}

d(
  'real texture -> RGBA32 -> LZ4_HC rebuild must be strict-LZ4 valid (regression for corrupt 8.4MB block)',
  { timeout: 180000 },
  async () => {
    const buf = fs.readFileSync(ORIG);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const meta = (await import('@/utils/khDecrypt')).splitKhBundle(ab);
    const unityFs = isKhBundle(ab) ? decryptKhBundle(ab) : ab;
    const bundle: any = await loadAssetBundle(unityFs.slice(0));

    const tex: any = (bundle.objects as any[]).find(o => o.type === AssetType.Texture2D);
    const w = tex.width, h = tex.height;

    const sPath = tex.streamData.path.split('/').pop()!;
    const nodeIndex = bundle.nodes.findIndex((n: any) => n.path === sPath);
    const offset = tex.streamData.offset, oldSize = tex.streamData.size;
    const raw = new Uint8Array(bundle.files[nodeIndex]).slice(offset, offset + oldSize);
    const rgba = bgraToRgba(decodeTexture(raw, w, h, tex.textureFormat, tex.name));
    const finalEncoded = encodeTextureWithMips(rgba as Uint8Array<ArrayBuffer>, w, h, TextureFormat.RGBA32, 0);

    Object.defineProperty(tex, 'textureFormat', { value: TextureFormat.RGBA32, writable: true, configurable: true });
    (tex as any)._modifiedTextureFormat = TextureFormat.RGBA32;
    if (finalEncoded.length > oldSize) {
      const oldNodeData = new Uint8Array(bundle.files[nodeIndex]);
      const extra = finalEncoded.length - oldSize;
      const tailStart = offset + oldSize;
      const tailData = tailStart < oldNodeData.length ? oldNodeData.slice(tailStart) : new Uint8Array(0);
      const nd = new Uint8Array(oldNodeData.length + extra);
      nd.set(oldNodeData.slice(0, offset), 0); nd.set(finalEncoded, offset); nd.set(tailData, offset + finalEncoded.length);
      bundle.files[nodeIndex] = nd.buffer;
    } else {
      new Uint8Array(bundle.files[nodeIndex]).set(finalEncoded, offset);
    }
    Object.defineProperty(tex.streamData, 'size', { value: finalEncoded.length, writable: true, configurable: true });

    const objInfo = (tex as any).__info;
    const objWriter = new ArrayBufferWriter(objInfo.bytesSize);
    tex.serialize(objWriter);
    const serialized = new Uint8Array(objWriter.getBuffer().slice(0, objWriter.position));
    const assetNodeIndex = bundle.nodes.findIndex((n: any) => n.path === objInfo.asset.path);
    new Uint8Array(bundle.files[assetNodeIndex]).set(serialized, objInfo.bytesStart);

    // 导出：LZ4_HC（用户选择的压缩模式）
    const rebuilt: ArrayBuffer = bundle.rebuild(3);
    const enc: ArrayBuffer = encryptUnityFsToKh(rebuilt, meta, meta.signature, FILE_NAME);

    const tmp = 'research/_regress_rgb32_lz4hc.bin';
    fs.writeFileSync(tmp, Buffer.from(enc.slice(0)));

    // 1) 权威校验：官方 lz4 C 库（游戏端同款严格解码器）
    let authoritative = false;
    let note = '';
    if (fs.existsSync(VENV_PY)) {
      try {
        const out = execFileSync(VENV_PY, ['research/strict_check_one.py', tmp], { encoding: 'utf8' });
        note = out.trim();
        authoritative = 'ALL OK' === note;
      } catch (e: any) {
        note = (e.stdout || '') + (e.stderr || '') || String(e);
        authoritative = false;
      }
    }

    // 2) 兜底：lz4js 往返（捕获 n+5 越界类损坏）
    let fallback = false;
    {
      // 直接对 8.4MB 拼接块做 compressLz4，再用 lz4js 解码校验长度
      const total = bundle.files.reduce((a: number, f: ArrayBuffer) => a + f.byteLength, 0);
      const blk = new Uint8Array(total);
      let off = 0;
      for (const f of bundle.files as ArrayBuffer[]) { blk.set(new Uint8Array(f), off); off += f.byteLength; }
      const { compressLz4 } = await import('@arkntools/unity-js');
      const comp = compressLz4(blk);
      const out = Buffer.alloc(total);
      const n = decompressBlock(comp, out as any, 0, comp.length, 0);
      fallback = n === total;
    }

    console.log(`[regression] strict(python)=${authoritative ? 'ALL OK' : 'FAIL (' + note + ')'} | lz4js-roundtrip=${fallback}`);
    // 至少兜底必须通过；若 python 可用则必须以官方校验为准
    expect(fallback, 'lz4js round-trip must reproduce exact block size').toBe(true);
    if (fs.existsSync(VENV_PY)) {
      expect(authoritative, `official lz4 strict check: ${note}`).toBe(true);
    }
  },
);
