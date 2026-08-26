import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { loadAssetBundle } from '@arkntools/unity-js';

const SAMPLE =
  'C:/Users/34072/Desktop/纯立绘/A纯立绘/「和服」夕日红_pvp90176/3569823446解密.assetbundle';
const exists = fs.existsSync(SAMPLE);

const rtBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

describe.skipIf(!exists)('bundle.rebuild preserves LZ4 compression (real sample)', () => {
  it('rebuild roundtrip: content lossless + size stays compressed', async () => {
    const buf = fs.readFileSync(SAMPLE);
    const origSize = buf.length;
    const bundle = await loadAssetBundle(toArrayBuffer(buf));
    const origFiles = (bundle as any).files as ArrayBuffer[];

    // 不修改任何内容，直接 rebuild（应保留原 LZ4 压缩态）
    const rebuilt = bundle.rebuild();
    const rebuiltSize = rebuilt.byteLength;
    // eslint-disable-next-line no-console
    console.log(`[rebuild] orig=${origSize} rebuilt=${rebuiltSize} ratio=${(rebuiltSize / origSize).toFixed(3)}x`);

    // 关键断言：写回不应从压缩膨胀到未压缩（原 bug 是 ~3.3x 膨胀）
    expect(rebuiltSize).toBeLessThan(Math.ceil(origSize * 1.6));

    // 内容无损：重新加载后 file data 与原文逐字节一致
    const reloaded = await loadAssetBundle(rebuilt.slice(0));
    const newFiles = (reloaded as any).files as ArrayBuffer[];
    expect(newFiles.length).toBe(origFiles.length);
    for (let i = 0; i < newFiles.length; i++) {
      expect(rtBytes(new Uint8Array(newFiles[i]), new Uint8Array(origFiles[i])), `file[${i}]`).toBe(true);
    }
  });
});
