/**
 * ETC2 RGBA8 解码补丁（移植自 @arkntools/unity-js-tools 的 patches/etc2.js）。
 *
 * 背景：unity-js-tools-wasm 的 decodeEtc2Rgba8 在浏览器端 alpha 通道解析有缺陷
 * （A8 块数据未正确解出），此补丁用 ETC2 A8 算法重新填充 alpha 通道。
 * 直接内联进项目：unity-js-tools 的 __exportStar 运行时 re-export 无法被静态分析枚举
 * （vite dev 下 named import 报 "does not provide an export"），相关依赖已改为
 * 从 wasm 包的 .mjs 副本（ESM 语义）导入。
 */
import { decodeEtc2Rgba8 as decodeEtc2Rgba8Base } from '@arkntools/unity-js-tools-wasm';

const toUint64 = (data: Uint8Array): bigint =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0);

const clamp = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n);

const ETC2_ALPHA_MOD_TABLE = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

const WRITE_ORDER_TABLE_REV = [15, 11, 7, 3, 14, 10, 6, 2, 13, 9, 5, 1, 12, 8, 4, 0];

const decodeEtc2A8Block = (data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(16);
  if (data[1] & 0xf0) {
    const multiplier = data[1] >> 4;
    const table = ETC2_ALPHA_MOD_TABLE[data[1] & 0xf];
    for (let i = 0, l = toUint64(data); i < 16; i++, l >>= 3n) {
      out[WRITE_ORDER_TABLE_REV[i]] = clamp(data[0] + multiplier * table[Number(l & 7n)]);
    }
  } else {
    out.fill(data[0]);
  }
  return out;
};

const copyBlockAlpha = (
  bx: number,
  by: number,
  w: number,
  h: number,
  bw: number,
  bh: number,
  alpha: Uint8Array,
  image: Uint8Array,
) => {
  const x = bw * bx;
  const copyW = bw * (bx + 1) > w ? w - bw * bx : bw;
  const y0 = by * bh;
  const copyH = bh * (by + 1) > h ? h - y0 : bh;
  for (let y = y0, alphaOffset = 0; y < y0 + copyH; y++, alphaOffset += bw) {
    const imageOffset = y * w + x;
    for (let i = 0; i < copyW; i++) {
      image[(imageOffset + i) * 4 + 3] = alpha[alphaOffset + i];
    }
  }
};

export const decodeEtc2Rgba8 = (data: Uint8Array, width: number, height: number): Uint8Array => {
  const image = decodeEtc2Rgba8Base(data, width, height);
  const numBlocksX = Math.floor((width + 3) / 4);
  const numBlockY = Math.floor((height + 3) / 4);
  for (let by = 0, p = 0; by < numBlockY; by++) {
    for (let bx = 0; bx < numBlocksX; bx++, p += 16) {
      const alpha = decodeEtc2A8Block(data.subarray(p, p + 8));
      copyBlockAlpha(bx, by, width, height, 4, 4, alpha, image);
    }
  }
  return image;
};