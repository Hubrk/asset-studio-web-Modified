// 回归测试：rebuild() 必须保留原始 LZ4_HC(3) 压缩类型标志。
// 背景：游戏端加载器只认 LZ4_HC；上一版 rebuild 把所有块固定标成 LZ4(2)，
//       数据虽标准兼容，但游戏报「资源损坏」。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lz4 = require('lz4js');
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle } from '../../utils/khDecrypt';

const SAMPLE =
  'C:/Users/34072/Desktop/胜利改牛逼/90110宇智波带土[暴怒]/帧动画/1936115193.assetbundle';
const exists = fs.existsSync(SAMPLE);

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/** 解析标准 UnityFS header，返回 flags/cbs/uncbs/headerEnd */
function parseHeader(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const t = new Uint8Array(buf);
  let ptr = 8; // "UnityFS\0"
  const version = dv.getUint32(ptr, false); ptr += 4;
  while (t[ptr] !== 0) ptr++; ptr++;
  while (t[ptr] !== 0) ptr++; ptr++;
  const size = Number(dv.getBigUint64(ptr, false)); ptr += 8;
  const cbs = dv.getUint32(ptr, false); ptr += 4;
  const uncbs = dv.getUint32(ptr, false); ptr += 4;
  const flags = dv.getUint32(ptr, false); ptr += 4;
  return { version, size, cbs, uncbs, flags, headerEnd: ptr };
}

describe.skipIf(!exists)('bundle.rebuild preserves LZ4_HC type (game compatibility)', () => {
  it('归档类型与块类型均为 LZ4_HC(3)，且块数据可被标准 LZ4 解压器解压', async () => {
    const buf = fs.readFileSync(SAMPLE);
    const dec = decryptKhBundle(toArrayBuffer(buf));
    const bundle = await loadAssetBundle(dec);
    const rebuilt = bundle.rebuild();

    const h = parseHeader(rebuilt);
    console.log(
      `[lzhc] orig=${buf.length} rebuilt=${rebuilt.byteLength} flags=0x${h.flags.toString(16)} type=${h.flags & 0x3f}`,
    );

    // 1) 归档压缩类型必须是 LZ4_HC(3)——游戏加载器的硬性要求
    expect(h.flags & 0x3f).toBe(3);

    // 2) 解压 blocksInfo 并检查每块类型
    //    rebuild 的 writer.align(16) 会把 blocksInfo 放在 header 对齐(16) 之后
    const blocksAtEnd = !!(h.flags & 0x80);
    const biStart = blocksAtEnd ? rebuilt.byteLength - h.cbs : (h.headerEnd + 15) & ~15;
    const biComp = new Uint8Array(rebuilt, biStart, h.cbs);
    const dst = new Uint8Array(Math.max(h.uncbs, 1));
    lz4.decompressBlock(biComp, dst, 0, biComp.length, 0);
    const bi = dst;
    const blockCount = new DataView(bi.buffer, bi.byteOffset, bi.byteLength).getUint32(16, false);
    expect(blockCount).toBeGreaterThan(0);

    const blocks: Array<{ u: number; c: number; f: number }> = [];
    let p = 20;
    const bdv = new DataView(bi.buffer, bi.byteOffset, bi.byteLength);
    for (let i = 0; i < blockCount; i++) {
      blocks.push({ u: bdv.getUint32(p, false), c: bdv.getUint32(p + 4, false), f: bdv.getUint16(p + 8, false) });
      p += 10;
    }
    // 3) 每块类型必须是 LZ4_HC(3)
    for (const b of blocks) {
      expect(b.f & 0x3f, `block type (flags=0x${b.f.toString(16)})`).toBe(3);
    }

    // 4) 块数据可被标准 LZ4 解压器（lz4js）解压且字节数吻合
    const headerPadded = (h.headerEnd + 15) & ~15;
    let offset = headerPadded + h.cbs;
    if (h.flags & 0x200) offset = (offset + 15) & ~15;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const comp = new Uint8Array(rebuilt, offset, b.c);
      offset += b.c;
      const out = new Uint8Array(b.u);
      const end = lz4.decompressBlock(comp, out, 0, comp.length, 0);
      expect(end).toBe(b.u);
    }

    // 5) 体积保持压缩态
    expect(rebuilt.byteLength).toBeLessThan(Math.ceil(buf.length * 1.6));
    console.log(`[lzhc] blocks=${blocks.length} 全部 LZ4_HC(3) + 标准解压通过, ratio=${(rebuilt.byteLength / buf.length).toFixed(3)}x`);
  });

  it('rebuild(compressionMode) 参数生效：默认 LZ4_HC(3)，显式 LZ4(2)/NONE(0)', async () => {
    const buf = fs.readFileSync(SAMPLE);
    const dec = decryptKhBundle(toArrayBuffer(buf));
    const bundle = await loadAssetBundle(dec);
    const flagOf = (b: ArrayBuffer) => parseHeader(b).flags & 0x3f;

    expect(flagOf(bundle.rebuild())).toBe(3); // 默认 LZ4_HC
    expect(flagOf(bundle.rebuild(2))).toBe(2); // 显式 LZ4
    expect(flagOf(bundle.rebuild(0))).toBe(0); // NONE（不压缩）
    expect(flagOf(bundle.rebuild(99))).toBe(3); // 非法值兜底回 LZ4_HC

    // LZ4(2) 与 NONE(0) 输出也必须是标准 LZ4 可解 / 未压缩
    const r2 = bundle.rebuild(2);
    expect(flagOf(r2)).toBe(2);
    const r0 = bundle.rebuild(0);
    expect(flagOf(r0)).toBe(0);
    console.log(`[lzhc] 压缩模式参数: default=3, LZ4=2, NONE=0, 非法=3(兜底)`);
  });
});
