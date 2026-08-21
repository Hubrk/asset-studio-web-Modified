/**
 * 纹理编码器 - 将 RGBA 像素数据编码为 Unity 纹理格式
 *
 * 支持格式：
 * - RGBA32/BGRA32: 直接复制（交换 R/B）
 * - DXT1/DXT5(BC3): 4x4 块压缩
 * - BC7: 模式 6（2 RGBA 端点，7 bit/通道，4 bit 索引）
 * - ASTC RGB/RGBA 4x4 ~ 12x12: void extent 常数颜色模式
 *
 * 解码器约定：decodeTexture 输出 BGRA，然后 bgra2rgba 转为 RGBA。
 * 因此编码器存储 RGBA 值，解码器读取后输出 BGRA，bgra2rgba 还原 RGBA。
 */
import { TextureFormat as TF } from '@arkntools/unity-js';

type EncodeFunction = (rgba: Uint8Array<ArrayBuffer>, width: number, height: number) => Uint8Array<ArrayBuffer>;

/** 8-bit → 7-bit 转换（BC7 端点，配合 P-bit：完整 8-bit 值 = (ep7 << 1) | P） */
const to7bitWithP = (v: number): number => Math.min(v >> 1, 127);

/** RGB565 编码 */
const to565 = (r: number, g: number, b: number): number =>
  (((r >> 3) & 0x1f) << 11) | (((g >> 2) & 0x3f) << 5) | ((b >> 3) & 0x1f);

/** 收集块像素（越界时使用边缘像素），支持任意块大小 */
const collectBlock = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  bx: number,
  by: number,
  blockW: number,
  blockH: number,
): number[][] => {
  const pixels: number[][] = [];
  for (let py = 0; py < blockH; py++) {
    for (let px = 0; px < blockW; px++) {
      const x = Math.min(bx * blockW + px, width - 1);
      const y = Math.min(by * blockH + py, height - 1);
      const idx = (y * width + x) * 4;
      pixels.push([rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]]);
    }
  }
  return pixels;
};

/** 计算像素亮度 */
const luminance = (p: number[]): number => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

/** RGBA32 编码器：直接复制 */
const encodeRgba32: EncodeFunction = rgba => new Uint8Array(rgba);

/** DXT5/BC3 编码器（4级颜色插值 + 8级 alpha 插值） */
const encodeDxt5: EncodeFunction = (rgba, width, height) => {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const output = new Uint8Array(blocksX * blocksY * 16);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 16;
      const pixels = collectBlock(rgba, width, height, bx, by, 4, 4);

      // --- Alpha 端点（8级插值）---
      let minA = 255, maxA = 0;
      for (const px of pixels) {
        if (px[3] < minA) minA = px[3];
        if (px[3] > maxA) maxA = px[3];
      }
      output[off] = maxA;
      output[off + 1] = minA;

      // 8级 alpha 插值（a0 > a1 模式）
      const aLevels = [maxA, minA];
      for (let i = 1; i <= 6; i++) {
        aLevels.push(Math.round((maxA * (7 - i) + minA * i) / 7));
      }

      // 为每个像素选择最近的 alpha 级别
      let alphaBits = 0n;
      for (let i = 0; i < 16; i++) {
        const a = pixels[i][3];
        let bestIdx = 0, bestDist = Infinity;
        for (let j = 0; j < 8; j++) {
          const d = Math.abs(a - aLevels[j]);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        alphaBits |= BigInt(bestIdx) << BigInt(i * 3);
      }
      for (let i = 0; i < 6; i++) {
        output[off + 2 + i] = Number((alphaBits >> BigInt(i * 8)) & 0xffn);
      }

      // --- 颜色端点（4级插值，RGB565）---
      let minC = pixels[0], maxC = pixels[0];
      let minL = Infinity, maxL = -Infinity;
      for (const px of pixels) {
        const l = luminance(px);
        if (l < minL) { minL = l; minC = px; }
        if (l > maxL) { maxL = l; maxC = px; }
      }
      const c0 = to565(maxC[0], maxC[1], maxC[2]);
      const c1 = to565(minC[0], minC[1], minC[2]);
      const colorView = new DataView(output.buffer, off + 8, 8);
      colorView.setUint16(0, c0, true);
      colorView.setUint16(2, c1, true);

      // 4级颜色插值（c0 > c1 模式）
      const c0r = (c0 >> 11) & 0x1f, c0g = (c0 >> 5) & 0x3f, c0b = c0 & 0x1f;
      const c1r = (c1 >> 11) & 0x1f, c1g = (c1 >> 5) & 0x3f, c1b = c1 & 0x1f;
      const r0 = (c0r << 3) | (c0r >> 2), g0 = (c0g << 2) | (c0g >> 4), b0 = (c0b << 3) | (c0b >> 2);
      const r1 = (c1r << 3) | (c1r >> 2), g1 = (c1g << 2) | (c1g >> 4), b1 = (c1b << 3) | (c1b >> 2);
      const levels = [
        [r0, g0, b0],
        [r1, g1, b1],
        [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)],
        [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)],
      ];

      // 为每个像素选择最近的颜色级别
      let colorBits = 0;
      for (let i = 0; i < 16; i++) {
        const px = pixels[i];
        let bestIdx = 0, bestDist = Infinity;
        for (let j = 0; j < 4; j++) {
          const d = Math.abs(px[0] - levels[j][0]) + Math.abs(px[1] - levels[j][1]) + Math.abs(px[2] - levels[j][2]);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        colorBits |= bestIdx << (i * 2);
      }
      colorView.setUint32(4, colorBits, true);
    }
  }
  return output;
};
/** DXT1/BC1 编码器（4级颜色插值，无 alpha） */
const encodeDxt1: EncodeFunction = (rgba, width, height) => {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const output = new Uint8Array(blocksX * blocksY * 8);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 8;
      const pixels = collectBlock(rgba, width, height, bx, by, 4, 4);

      let minC = pixels[0], maxC = pixels[0];
      let minL = Infinity, maxL = -Infinity;
      for (const px of pixels) {
        const l = luminance(px);
        if (l < minL) { minL = l; minC = px; }
        if (l > maxL) { maxL = l; maxC = px; }
      }
      const c0 = to565(maxC[0], maxC[1], maxC[2]);
      const c1 = to565(minC[0], minC[1], minC[2]);
      const view = new DataView(output.buffer, off, 8);
      view.setUint16(0, c0, true);
      view.setUint16(2, c1, true);

      // 4级颜色插值（c0 > c1 模式）
      const c0r = (c0 >> 11) & 0x1f, c0g = (c0 >> 5) & 0x3f, c0b = c0 & 0x1f;
      const c1r = (c1 >> 11) & 0x1f, c1g = (c1 >> 5) & 0x3f, c1b = c1 & 0x1f;
      const r0 = (c0r << 3) | (c0r >> 2), g0 = (c0g << 2) | (c0g >> 4), b0 = (c0b << 3) | (c0b >> 2);
      const r1 = (c1r << 3) | (c1r >> 2), g1 = (c1g << 2) | (c1g >> 4), b1 = (c1b << 3) | (c1b >> 2);
      const levels = [
        [r0, g0, b0],
        [r1, g1, b1],
        [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3)],
        [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3)],
      ];

      let colorBits = 0;
      for (let i = 0; i < 16; i++) {
        const px = pixels[i];
        let bestIdx = 0, bestDist = Infinity;
        for (let j = 0; j < 4; j++) {
          const d = Math.abs(px[0] - levels[j][0]) + Math.abs(px[1] - levels[j][1]) + Math.abs(px[2] - levels[j][2]);
          if (d < bestDist) { bestDist = d; bestIdx = j; }
        }
        colorBits |= bestIdx << (i * 2);
      }
      view.setUint32(4, colorBits, true);
    }
  }
  return output;
};
/**
 * BC7 编码器（模式 6，16级索引插值）
 *
 * Mode 6 = bit 6 置位 (0x40)。
 * 完整 8-bit 端点值 = (ep7 << 1) | P
 *
 * 改进：使用完整 0-15 级索引（4-bit），通过最小二乘法
 * 计算每个像素的最优插值权重，大幅提升色彩过渡平滑度。
 */
const encodeBc7: EncodeFunction = (rgba, width, height) => {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const output = new Uint8Array(blocksX * blocksY * 16);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 16;
      const pixels = collectBlock(rgba, width, height, bx, by, 4, 4);

      // 选择端点：最暗和最亮像素
      let minP = pixels[0], maxP = pixels[0];
      let minL = Infinity, maxL = -Infinity;
      for (const px of pixels) {
        const l = luminance(px);
        if (l < minL) { minL = l; minP = px; }
        if (l > maxL) { maxL = l; maxP = px; }
      }

      // P-bit 取 alpha LSB，确保 alpha 精确 round-trip
      const p0 = maxP[3] & 1;
      const p1 = minP[3] & 1;

      let bits = 0n;

      // Mode 6: bit 6 = 1
      bits |= 1n << 6n;
      let pos = 7;

      // 端点按通道分组：R0,R1,G0,G1,B0,B1,A0,A1
      bits |= BigInt(to7bitWithP(maxP[0])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(minP[0])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(maxP[1])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(minP[1])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(maxP[2])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(minP[2])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(maxP[3])) << BigInt(pos);
      pos += 7;
      bits |= BigInt(to7bitWithP(minP[3])) << BigInt(pos);
      pos += 7;

      // P0, P1 各 1 bit
      bits |= BigInt(p0) << BigInt(pos);
      pos += 1;
      bits |= BigInt(p1) << BigInt(pos);
      pos += 1;

      // Index 0 (anchor): 3 bits, MSB 隐含 0
      pos += 3;

      // 完整端点值 = (ep7 << 1) | P
      const er0 = (to7bitWithP(maxP[0]) << 1) | p0;
      const er1 = (to7bitWithP(minP[0]) << 1) | p1;
      const eg0 = (to7bitWithP(maxP[1]) << 1) | p0;
      const eg1 = (to7bitWithP(minP[1]) << 1) | p1;
      const eb0 = (to7bitWithP(maxP[2]) << 1) | p0;
      const eb1 = (to7bitWithP(minP[2]) << 1) | p1;
      const ea0 = (to7bitWithP(maxP[3]) << 1) | p0;
      const ea1 = (to7bitWithP(minP[3]) << 1) | p1;

      // 方向向量
      const dr = er1 - er0, dg = eg1 - eg0, db = eb1 - eb0, da = ea1 - ea0;
      const dd = dr * dr + dg * dg + db * db + da * da;

      // Index 1-15: 4 bits each，使用最小二乘法计算最优插值权重
      for (let i = 1; i < 16; i++) {
        const px = pixels[i];
        let idx: number;
        if (dd === 0) {
          idx = 0;
        } else {
          // 投影到端点方向，计算最优插值权重 [0, 1]
          const t = ((px[0] - er0) * dr + (px[1] - eg0) * dg + (px[2] - eb0) * db + (px[3] - ea0) * da) / dd;
          // 量化到 0-15
          idx = Math.max(0, Math.min(15, Math.round(t * 15)));
        }
        bits |= BigInt(idx) << BigInt(pos);
        pos += 4;
      }

      const view = new DataView(output.buffer, off, 16);
      for (let i = 0; i < 16; i++) {
        view.setUint8(i, Number((bits >> BigInt(i * 8)) & 0xffn));
      }
    }
  }
  return output;
};
/**
 * ASTC void-extent 块编码（常数颜色块）
 *
 * 位布局（128 bits，经 WASM 解码器验证）：
 * - bits [8:0]   = 0x1FC (void extent 标记)
 * - bits [10:9]  = 0b10 (必须非零)
 * - bits [63:11] = 坐标字段 (53 bit, 全 1 = 覆盖整个纹理)
 * - bits [79:64]  = R (16 bit UNORM, (v<<8)|v)
 * - bits [95:80]  = G (16 bit UNORM)
 * - bits [111:96] = B (16 bit UNORM)
 * - bits [127:112] = A (16 bit UNORM)
 */
const writeAstcVoidExtent = (output: Uint8Array, off: number, r: number, g: number, b: number, a: number): void => {
  let bits = 0n;
  bits |= 0x1fcn;
  bits |= 0b10n << 9n;
  bits |= ((1n << 53n) - 1n) << 11n;
  bits |= BigInt((r << 8) | r) << 64n;
  bits |= BigInt((g << 8) | g) << 80n;
  bits |= BigInt((b << 8) | b) << 96n;
  bits |= BigInt((a << 8) | a) << 112n;
  const view = new DataView(output.buffer, off, 16);
  for (let i = 0; i < 16; i++) {
    view.setUint8(i, Number((bits >> BigInt(i * 8)) & 0xffn));
  }
};

/** 字节内位反转（移植自 ARM astcenc bitrev8） */
const bitrev8 = (p: number): number => {
  p = ((p & 0x0f) << 4) | ((p >> 4) & 0x0f);
  p = ((p & 0x33) << 2) | ((p >> 2) & 0x33);
  p = ((p & 0x55) << 1) | ((p >> 1) & 0x55);
  return p & 0xff;
};

/** LSB-first 位写入（移植自 ARM astcenc write_bits） */
const writeBitsLE = (buf: Uint8Array, value: number, bitcount: number, bitoffset: number): void => {
  const mask = (1 << bitcount) - 1;
  value &= mask;
  const bytePos = bitoffset >> 3;
  const bitShift = bitoffset & 7;
  const shiftedValue = value << bitShift;
  const shiftedMask = mask << bitShift;
  buf[bytePos] &= ~shiftedMask & 0xff;
  buf[bytePos] |= shiftedValue & 0xff;
  if (bytePos + 1 < buf.length) {
    buf[bytePos + 1] &= ~(shiftedMask >> 8) & 0xff;
    buf[bytePos + 1] |= (shiftedValue >> 8) & 0xff;
  }
};

/**
 * ASTC 2-端点插值块编码（PCA 优化版）
 *
 * 使用 6x6 + 1-bit 权重 (QUANT_2) + QUANT_256 端点（纯 8-bit，无 scramble，无 ISE）
 *
 * 物理块布局（128 bits，单分区，来自 ARM astcenc symbolic_to_physical）：
 * - bits [10:0]   = block_mode = 0x104 (6x6, 1-bit weight, QUANT_2)
 * - bits [12:11]  = partition_count - 1 = 0
 * - bits [16:13]  = CEM (8=RGB direct / 12=RGBA direct)
 * - bits [17..]   = 端点数据（交织：R0,R1,G0,G1,B0,B1[,A0,A1]，每值 8-bit）
 * - bits [127..92] = 权重数据（36 × 1-bit，ISE 纯二进制编码后 bswap）
 *
 * 权重反量化 (1-bit, QUANT_2)：[0, 64] → 2 级插值
 * 端点反量化 (8-bit, QUANT_256)：直接使用 0..255
 *
 * 算法改进：
 * 1. 4D PCA 端点选择（含 alpha 通道）：找到 RGBA 空间的主方差方向，
 *    投影极值作为端点。这确保 alpha 变化被捕获，避免 alpha halo。
 * 2. 最近端点权重分配：每个 texel 分配到 4D 距离最近的端点，
 *    最小化逐像素误差。
 */
const writeAstc2Endpoint = (
  output: Uint8Array,
  off: number,
  pixels: number[][],
  blockW: number,
  blockH: number,
  hasAlpha: boolean,
): void => {
  const channels = hasAlpha ? 4 : 3;
  const n = pixels.length;

  // 1. 计算质心
  const centroid = new Float64Array(channels);
  for (const p of pixels) {
    for (let c = 0; c < channels; c++) centroid[c] += p[c];
  }
  for (let c = 0; c < channels; c++) centroid[c] /= n;

  // 2. 计算协方差矩阵（上三角，对称）
  const cov = new Float64Array(channels * channels);
  for (const p of pixels) {
    const d = new Float64Array(channels);
    for (let c = 0; c < channels; c++) d[c] = p[c] - centroid[c];
    for (let i = 0; i < channels; i++) {
      for (let j = i; j < channels; j++) {
        cov[i * channels + j] += d[i] * d[j];
      }
    }
  }

  // 3. 幂迭代求主特征向量（最大方差方向）
  let v = new Float64Array(channels);
  // 初始向量：偏好 alpha 方向（index 3），确保 alpha 变化被优先捕获
  if (hasAlpha) { v[0] = 1; v[1] = 1; v[2] = 1; v[3] = 2; }
  else { v[0] = 1; v[1] = 1; v[2] = 1; }
  let vlen = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (vlen > 0) for (let i = 0; i < channels; i++) v[i] /= vlen;

  for (let iter = 0; iter < 16; iter++) {
    const vnew = new Float64Array(channels);
    for (let i = 0; i < channels; i++) {
      for (let j = 0; j < channels; j++) {
        // 对称矩阵：cov[i*channels+j] 和 cov[j*channels+i] 相同
        const idx = i <= j ? i * channels + j : j * channels + i;
        vnew[i] += cov[idx] * v[j];
      }
    }
    vlen = Math.sqrt(vnew.reduce((s, x) => s + x * x, 0));
    if (vlen < 1e-6) break;
    let maxDelta = 0;
    for (let i = 0; i < channels; i++) {
      const nv = vnew[i] / vlen;
      maxDelta = Math.max(maxDelta, Math.abs(nv - v[i]));
      v[i] = nv;
    }
    if (maxDelta < 1e-6) break;
  }

  // 4. 投影到主方向，找投影极值对应的像素作为端点
  let minProj = Infinity, maxProj = -Infinity;
  let minP = pixels[0], maxP = pixels[0];
  for (const p of pixels) {
    let proj = 0;
    for (let c = 0; c < channels; c++) proj += (p[c] - centroid[c]) * v[c];
    if (proj < minProj) { minProj = proj; minP = p; }
    if (proj > maxProj) { maxProj = proj; maxP = p; }
  }

  // 端点值（QUANT_256 = 纯 8-bit，无需量化/反量化/scramble）
  const ur0 = minP[0], ug0 = minP[1], ub0 = minP[2], ua0 = minP[3];
  const ur1 = maxP[0], ug1 = maxP[1], ub1 = maxP[2], ua1 = maxP[3];

  // 5. 权重分配：最近端点（4D 距离，最小化逐像素误差）
  const weights: number[] = [];
  for (const p of pixels) {
    let d0 = 0, d1 = 0;
    if (hasAlpha) {
      d0 = (p[0] - ur0) ** 2 + (p[1] - ug0) ** 2 + (p[2] - ub0) ** 2 + (p[3] - ua0) ** 2;
      d1 = (p[0] - ur1) ** 2 + (p[1] - ug1) ** 2 + (p[2] - ub1) ** 2 + (p[3] - ua1) ** 2;
    } else {
      d0 = (p[0] - ur0) ** 2 + (p[1] - ug0) ** 2 + (p[2] - ub0) ** 2;
      d1 = (p[0] - ur1) ** 2 + (p[1] - ug1) ** 2 + (p[2] - ub1) ** 2;
    }
    weights.push(d1 < d0 ? 1 : 0);
  }

  // 构建块模式与 CEM
  const blockMode = 0x104; // 6x6 + 1-bit weight (QUANT_2)
  const cem = hasAlpha ? 12 : 8; // RGBA direct (8值) 或 RGB direct (6值)

  // 1. ISE 编码权重到 weightbuf（1-bit 纯二进制，从 bit 0 开始）
  const weightbuf = new Uint8Array(16);
  for (let i = 0; i < weights.length; i++) {
    writeBitsLE(weightbuf, weights[i], 1, i);
  }

  // 2. bswap 权重到 pcb：pcb[i] = bitrev8(weightbuf[15 - i])
  const pcb = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    pcb[i] = bitrev8(weightbuf[15 - i]);
  }

  // 3. 写入 block_mode (11 bits at bit 0)
  writeBitsLE(pcb, blockMode, 11, 0);
  // 4. 写入 partition_count - 1 = 0 (2 bits at bit 11)
  writeBitsLE(pcb, 0, 2, 11);
  // 5. 写入 CEM (4 bits at bit 13)
  writeBitsLE(pcb, cem, 4, 13);

  // 6. 写入端点数据（交织：R0,R1,G0,G1,B0,B1[,A0,A1]，每值 8-bit，从 bit 17 开始）
  let bitPos = 17;
  const endpointValues = hasAlpha
    ? [ur0, ur1, ug0, ug1, ub0, ub1, ua0, ua1]
    : [ur0, ur1, ug0, ug1, ub0, ub1];
  for (const v of endpointValues) {
    writeBitsLE(pcb, v, 8, bitPos);
    bitPos += 8;
  }

  // 复制到输出
  output.set(pcb, off);
};

/**
 * ASTC 编码器（支持任意块大小）
 *
 * 策略：
 * - 纯色块 → void-extent（精确颜色，12 bit/通道）
 * - 6x6 非纯色块 → 2-端点插值模式（1-bit 权重, QUANT_256 端点）
 * - 其他块大小非纯色 → void-extent（暂未实现其他块大小的 2-端点模式）
 */
const encodeAstc = (blockW: number, blockH: number, hasAlpha: boolean): EncodeFunction => (rgba, width, height) => {
  const blocksX = Math.ceil(width / blockW);
  const blocksY = Math.ceil(height / blockH);
  const output = new Uint8Array(blocksX * blocksY * 16);
  const pixelCount = blockW * blockH;

  // 2-端点模式仅支持 6x6（已验证 block_mode=0x104, 1-bit weight, QUANT_256 端点）
  const canUse2Endpoint = blockW === 6 && blockH === 6;

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const off = (by * blocksX + bx) * 16;
      const pixels = collectBlock(rgba, width, height, bx, by, blockW, blockH);

      // 检查是否为纯色块（含 alpha 通道，避免 alpha 变化块被误判为纯色）
      let isSolid = true;
      const p0 = pixels[0];
      for (const p of pixels) {
        if (Math.abs(p[0] - p0[0]) > 2 || Math.abs(p[1] - p0[1]) > 2 || Math.abs(p[2] - p0[2]) > 2) {
          isSolid = false;
          break;
        }
        if (hasAlpha && Math.abs(p[3] - p0[3]) > 2) {
          isSolid = false;
          break;
        }
      }

      if (isSolid || !canUse2Endpoint) {
        // 纯色块或不支持 2-端点的块 → void-extent（平均值）
        let r = 0, g = 0, b = 0, a = 0;
        for (const p of pixels) { r += p[0]; g += p[1]; b += p[2]; a += p[3]; }
        r = Math.round(r / pixelCount);
        g = Math.round(g / pixelCount);
        b = Math.round(b / pixelCount);
        a = Math.round(a / pixelCount);
        writeAstcVoidExtent(output, off, r, g, b, a);
      } else {
        // 非纯色块 → 2-端点插值
        writeAstc2Endpoint(output, off, pixels, blockW, blockH, hasAlpha);
      }
    }
  }
  return output;
};

/** 编码器映射表 */
const encoderMap: Partial<Record<TF, EncodeFunction>> = {
  [TF.RGBA32]: encodeRgba32,
  [TF.BGRA32]: (rgba, w, h) => {
    // BGRA32: 交换 R 和 B
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = rgba[i + 2];
      out[i + 1] = rgba[i + 1];
      out[i + 2] = rgba[i];
      out[i + 3] = rgba[i + 3];
    }
    return out;
  },
  [TF.DXT1]: encodeDxt1,
  [TF.DXT5]: encodeDxt5,
  [TF.BC7]: encodeBc7,
  [TF.ASTC_RGB_4x4]: encodeAstc(4, 4, false),
  [TF.ASTC_RGB_5x5]: encodeAstc(5, 5, false),
  [TF.ASTC_RGB_6x6]: encodeAstc(6, 6, false),
  [TF.ASTC_RGB_8x8]: encodeAstc(8, 8, false),
  [TF.ASTC_RGB_10x10]: encodeAstc(10, 10, false),
  [TF.ASTC_RGB_12x12]: encodeAstc(12, 12, false),
  [TF.ASTC_RGBA_4x4]: encodeAstc(4, 4, true),
  [TF.ASTC_RGBA_5x5]: encodeAstc(5, 5, true),
  [TF.ASTC_RGBA_6x6]: encodeAstc(6, 6, true),
  [TF.ASTC_RGBA_8x8]: encodeAstc(8, 8, true),
  [TF.ASTC_RGBA_10x10]: encodeAstc(10, 10, true),
  [TF.ASTC_RGBA_12x12]: encodeAstc(12, 12, true),
};

/**
 * 编码 RGBA 像素数据为目标纹理格式
 *
 * @param rgba RGBA 像素数据（Uint8Array，每像素 4 字节）
 * @param width 纹理宽度
 * @param height 纹理高度
 * @param format 目标纹理格式
 * @returns 编码后的 Uint8Array
 * @throws 不支持的格式时抛出错误
 */
export const encodeTexture = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  format: TF,
): Uint8Array<ArrayBuffer> => {
  const encoder = encoderMap[format];
  if (!encoder) {
    throw new Error(`Texture format "${format}" (${TF[format]}) encoder is not implemented.`);
  }
  return encoder(rgba, width, height);
};

/** 检查格式是否支持编码 */
export const isFormatSupported = (format: TF): boolean => format in encoderMap;

/** 获取支持的格式列表 */
export const getSupportedFormats = (): TF[] => Object.keys(encoderMap).map(k => Number(k) as TF);

/**
 * 垂直翻转 RGBA 数据的行序
 *
 * Canvas getImageData 输出 top-down（第一行是图片顶部），
 * Unity Texture2D 存储 bottom-up（第一行是纹理底部，OpenGL 原点左下）。
 * 编码前必须翻转，否则游戏渲染会上下颠倒。
 */
export const flipVerticalRgba = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(rgba.length);
  const rowSize = width * 4;
  for (let y = 0; y < height; y++) {
    const srcStart = y * rowSize;
    const dstStart = (height - 1 - y) * rowSize;
    out.set(rgba.subarray(srcStart, srcStart + rowSize), dstStart);
  }
  return out;
};

/**
 * Unsharp mask 锐化（强度与半径可调）
 *
 * 源图较糊 / 抠图重采样后边缘发糊时使用。对 RGB 三通道做高斯模糊差值：
 *   out = orig + amount * (orig - blurred)
 * alpha 通道保持原值不变。
 *
 * - radius=1：单遍 3x3 Gaussian（核 /16）
 * - radius=2：两遍 3x3 Gaussian（近似 5x5，作用范围更大，适合更糊的图）
 *
 * 应在 bleedAlpha 之后调用：透明区域 RGB 已被扩散为平滑色，卷积邻域
 * 干净，不会把 (0,0,0) 拉进边缘造成暗边。alpha=0 像素不参与渲染，
 * 其 RGB 即使被锐化也不可见。
 */
export interface SharpenOptions {
  /** 锐化强度 0~2，默认 1.0（适中；0.6 轻度 / 1.4 较强） */
  amount?: number;
  /** 高斯模糊半径：1（3x3）或 2（两遍 3x3 近似 5x5），默认 1 */
  radius?: 1 | 2;
}

/** 锐化强度预设（UI 与 worker 共用）：0=关闭，1=轻度，2=适中，3=较强 */
export const SHARPEN_PRESETS: Record<number, SharpenOptions> = {
  1: { amount: 0.6, radius: 1 },
  2: { amount: 1.0, radius: 1 },
  3: { amount: 1.4, radius: 2 },
};

/** 3x3 高斯模糊（核 /16：[1 2 1; 2 4 2; 1 2 1]），结果写入 out（仅 RGB，alpha 拷贝） */
const blur3x3 = (
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
): void => {
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < width - 1 ? x + 1 : width - 1;
      const oi = (y * width + x) * 4;
      dst[oi + 3] = src[oi + 3];
      const p00 = (y0 * width + x0) * 4;
      const p01 = (y0 * width + x) * 4;
      const p02 = (y0 * width + x1) * 4;
      const p10 = (y * width + x0) * 4;
      const p12 = (y * width + x1) * 4;
      const p20 = (y1 * width + x0) * 4;
      const p21 = (y1 * width + x) * 4;
      const p22 = (y1 * width + x1) * 4;
      for (let c = 0; c < 3; c++) {
        dst[oi + c] = Math.round(
          (src[p00 + c] + 2 * src[p01 + c] + src[p02 + c] +
            2 * src[p10 + c] + 4 * src[oi + c] + 2 * src[p12 + c] +
            src[p20 + c] + 2 * src[p21 + c] + src[p22 + c]) / 16,
        );
      }
    }
  }
};

export const sharpenRgba = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  options: SharpenOptions = {},
): Uint8Array<ArrayBuffer> => {
  const amount = options.amount ?? 1.0;
  const radius = options.radius ?? 1;
  const blur1 = new Uint8Array(rgba.length);
  blur3x3(rgba, blur1, width, height);
  // radius=2：对模糊结果再模糊一次（两遍 3x3 ≈ 5x5），作用范围更大
  const blurred = radius === 2 ? new Uint8Array(rgba.length) : blur1;
  if (radius === 2) blur3x3(blur1, blurred, width, height);

  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i + 3] = rgba[i + 3]; // alpha 原样
    for (let c = 0; c < 3; c++) {
      const orig = rgba[i + c];
      const sharp = orig + amount * (orig - blurred[i + c]);
      out[i + c] = sharp < 0 ? 0 : sharp > 255 ? 255 : Math.round(sharp);
    }
  }
  return out;
};

/**
 * Alpha bleeding：将完全透明像素（alpha=0）的 RGB 设为周围像素的平滑扩散色
 *
 * 导入的 PNG 透明背景区域 RGB=(0,0,0)。块压缩格式（ASTC/DXT/BC）每个块
 * 的端点取块内所有像素的最小/最大值，透明像素的 (0,0,0) 会把端点拉向
 * 黑色，导致边缘出现黑色锯齿。
 *
 * 只处理 alpha=0 的完全透明像素，保留半透明像素（0<alpha<255）的原始 RGB
 * （它们参与渲染 `final = src.rgb*src.a + dst*(1-a)`，RGB 是正确的不能改）。
 *
 * 使用迭代均值扩散（非 BFS 单一颜色蔓延）：每轮将"紧邻已确定像素"的
 * 透明像素设为已确定邻居的 RGB 平均值，远处透明像素变成周围颜色的平滑
 * 混合，块内 RGB 差异小，不会产生拉丝。
 */
export const bleedAlpha = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(rgba);
  const totalPixels = width * height;

  // determined[i]=1 表示该像素 RGB 已确定（alpha>0 或已扩散），不再修改
  // 注意：alpha>0 的像素（包括半透明）都视为"已确定"，保留原始 RGB
  const determined = new Uint8Array(totalPixels);
  let pending = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (out[i * 4 + 3] > 0) {
      determined[i] = 1;
    } else {
      pending++;
    }
  }
  // 无完全透明像素或全部透明，无需处理
  if (pending === 0 || pending === totalPixels) return out;

  // 复用累加 buffer
  const sumR = new Uint32Array(totalPixels);
  const sumG = new Uint32Array(totalPixels);
  const sumB = new Uint32Array(totalPixels);
  const cnt = new Uint8Array(totalPixels);

  // 最大迭代次数：足以覆盖最大透明区域的对角线
  const maxIter = Math.ceil(Math.log2(Math.max(width, height) + 1)) + 4;

  for (let iter = 0; iter < maxIter && pending > 0; iter++) {
    sumR.fill(0);
    sumG.fill(0);
    sumB.fill(0);
    cnt.fill(0);

    // 每个已确定像素向 4 个未确定的透明邻居贡献 RGB
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pidx = y * width + x;
        if (!determined[pidx]) continue;
        const idx = pidx * 4;
        const r = out[idx], g = out[idx + 1], b = out[idx + 2];

        if (y > 0) {
          const ni = pidx - width;
          if (!determined[ni]) {
            sumR[ni] += r; sumG[ni] += g; sumB[ni] += b; cnt[ni]++;
          }
        }
        if (y < height - 1) {
          const ni = pidx + width;
          if (!determined[ni]) {
            sumR[ni] += r; sumG[ni] += g; sumB[ni] += b; cnt[ni]++;
          }
        }
        if (x > 0) {
          const ni = pidx - 1;
          if (!determined[ni]) {
            sumR[ni] += r; sumG[ni] += g; sumB[ni] += b; cnt[ni]++;
          }
        }
        if (x < width - 1) {
          const ni = pidx + 1;
          if (!determined[ni]) {
            sumR[ni] += r; sumG[ni] += g; sumB[ni] += b; cnt[ni]++;
          }
        }
      }
    }

    // 更新本轮新确定的像素：RGB = 邻居平均值
    let changed = false;
    for (let i = 0; i < totalPixels; i++) {
      if (!determined[i] && cnt[i] > 0) {
        const idx = i * 4;
        out[idx] = Math.round(sumR[i] / cnt[i]);
        out[idx + 1] = Math.round(sumG[i] / cnt[i]);
        out[idx + 2] = Math.round(sumB[i] / cnt[i]);
        determined[i] = 1;
        pending--;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
};

/** 2x2 box filter 降采样（用于生成 mipmap 级别）。
 *  RGB 按 alpha 加权平均，避免透明像素（alpha=0）拉暗 mipmap 颜色。 */
const downsample2x = (
  rgba: Uint8Array<ArrayBuffer>,
  w: number,
  h: number,
): { data: Uint8Array<ArrayBuffer>; w: number; h: number } => {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = x * 2;
      const sy = y * 2;
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      let wr = 0, wg = 0, wb = 0, wsum = 0;
      for (let dy = 0; dy < 2 && sy + dy < h; dy++) {
        for (let dx = 0; dx < 2 && sx + dx < w; dx++) {
          const idx = ((sy + dy) * w + (sx + dx)) * 4;
          const pa = rgba[idx + 3];
          r += rgba[idx];
          g += rgba[idx + 1];
          b += rgba[idx + 2];
          a += pa;
          count++;
          // alpha 加权 RGB（只对不透明像素的 RGB 计算权重）
          wr += rgba[idx] * pa;
          wg += rgba[idx + 1] * pa;
          wb += rgba[idx + 2] * pa;
          wsum += pa;
        }
      }
      const oidx = (y * nw + x) * 4;
      out[oidx + 3] = Math.round(a / count);
      if (wsum > 0) {
        // 有不透明像素：用 alpha 加权 RGB
        out[oidx] = Math.round(wr / wsum);
        out[oidx + 1] = Math.round(wg / wsum);
        out[oidx + 2] = Math.round(wb / wsum);
      } else {
        // 全透明：用简单平均（bleed 后的 RGB）
        out[oidx] = Math.round(r / count);
        out[oidx + 1] = Math.round(g / count);
        out[oidx + 2] = Math.round(b / count);
      }
    }
  }
  return { data: out, w: nw, h: nh };
};

/**
 * 编码纹理并生成完整 mipmap 链
 *
 * 原始纹理数据通常包含多个 mip 级别（dataSize/streamData.size 大于 base level）。
 * 仅编码 base level 会导致剩余空间被零填充，游戏解码零填充区域时出现像素化重影。
 * 此函数从 base level 开始逐级 2x2 box filter 降采样并编码，拼接直到填满 targetSize。
 *
 * @param rgba      已翻转行序的 RGBA 像素数据（bottom-up，与 Unity 存储一致）
 * @param width     base level 宽度
 * @param height    base level 高度
 * @param format    目标纹理格式
 * @param targetSize 原始纹理数据总大小（含所有 mip 级别），0 表示仅 base level
 */
export const encodeTextureWithMips = (
  rgba: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  format: TF,
  targetSize: number,
): Uint8Array<ArrayBuffer> => {
  const baseEncoded = encodeTexture(rgba, width, height, format);

  // 无 mipmap 或 targetSize 未指定 → 仅返回 base level
  if (targetSize <= 0) return baseEncoded;

  // base level 已超过 targetSize（如导入更大尺寸图片）→ 返回完整 base level，
  // 不截断。调用方（modifyTexture2D）会更新 streamData.size 为实际长度。
  if (baseEncoded.length >= targetSize) return baseEncoded;

  // 生成完整 mip 链
  const parts: Uint8Array<ArrayBuffer>[] = [baseEncoded];
  let curRgba = rgba;
  let curW = width;
  let curH = height;
  let totalSize = baseEncoded.length;

  while (totalSize < targetSize && !(curW === 1 && curH === 1)) {
    const ds = downsample2x(curRgba, curW, curH);
    curRgba = ds.data;
    curW = ds.w;
    curH = ds.h;
    const mipEncoded = encodeTexture(curRgba, curW, curH, format);
    parts.push(mipEncoded);
    totalSize += mipEncoded.length;
  }

  // 拼接到 targetSize（最后一级可能被截断）
  const result = new Uint8Array(targetSize);
  let offset = 0;
  for (const p of parts) {
    const copyLen = Math.min(p.length, targetSize - offset);
    result.set(p.subarray(0, copyLen), offset);
    offset += copyLen;
    if (offset >= targetSize) break;
  }
  return result;
};
