import { describe, expect, it } from 'vitest';
import { TextureFormat as TF } from '@arkntools/unity-js';
import { encodeTexture, isFormatSupported, getSupportedFormats } from '../textureEncoder';
import { decodeTexture } from '@arkntools/unity-js';

/** 创建测试 RGBA 图像（8x8 渐变） */
const createTestImage = (width: number, height: number): Uint8Array<ArrayBuffer> => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx] = (x * 255) / (width - 1); // R: 水平渐变
      rgba[idx + 1] = (y * 255) / (height - 1); // G: 垂直渐变
      rgba[idx + 2] = 128; // B: 常数
      rgba[idx + 3] = 255; // A: 不透明
    }
  }
  return rgba;
};

/** 创建纯色测试图像 */
const createSolidImage = (
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8Array<ArrayBuffer> => {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
};

describe('纹理编码器', () => {
  describe('encodeTexture', () => {
    it('RGBA32 round-trip 应完全无损', () => {
      const w = 8,
        h = 8;
      const orig = createTestImage(w, h);
      const encoded = encodeTexture(orig, w, h, TF.RGBA32);
      // RGBA32 编码后大小应等于原始大小
      expect(encoded.length).toBe(orig.length);
      // 解码
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.RGBA32, 'test');
      // RGBA32 应完全一致
      for (let i = 0; i < orig.length; i++) {
        expect(decoded[i]).toBe(orig[i]);
      }
    });

    it('RGBA32 编码后大小正确', () => {
      const orig = createTestImage(16, 16);
      const encoded = encodeTexture(orig, 16, 16, TF.RGBA32);
      expect(encoded.length).toBe(16 * 16 * 4);
    });

    it('DXT5 编码后大小正确（16 bytes/block）', () => {
      const orig = createTestImage(8, 8);
      const encoded = encodeTexture(orig, 8, 8, TF.DXT5);
      // 8x8 = 2x2 blocks = 4 blocks × 16 bytes = 64 bytes
      expect(encoded.length).toBe(64);
    });

    it('DXT5 round-trip 解码后尺寸正确', () => {
      const w = 8,
        h = 8;
      const orig = createTestImage(w, h);
      const encoded = encodeTexture(orig, w, h, TF.DXT5);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.DXT5, 'test');
      expect(decoded.length).toBe(w * h * 4);
    });

    it('DXT5 纯色 round-trip 应接近无损', () => {
      const w = 4,
        h = 4;
      const orig = createSolidImage(w, h, 200, 100, 50);
      const encoded = encodeTexture(orig, w, h, TF.DXT5);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.DXT5, 'test');
      // 纯色块应该几乎无损（RGB565 量化误差 ≤ 4）
      for (let i = 0; i < w * h * 4; i += 4) {
        expect(Math.abs(decoded[i] - 200)).toBeLessThanOrEqual(8);
        expect(Math.abs(decoded[i + 1] - 100)).toBeLessThanOrEqual(8);
        expect(Math.abs(decoded[i + 2] - 50)).toBeLessThanOrEqual(8);
        expect(decoded[i + 3]).toBe(255);
      }
    });

    it('BC7 编码后大小正确（16 bytes/block）', () => {
      const orig = createTestImage(8, 8);
      const encoded = encodeTexture(orig, 8, 8, TF.BC7);
      expect(encoded.length).toBe(64);
    });

    it('BC7 round-trip 解码后尺寸正确', () => {
      const w = 8,
        h = 8;
      const orig = createTestImage(w, h);
      const encoded = encodeTexture(orig, w, h, TF.BC7);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.BC7, 'test');
      expect(decoded.length).toBe(w * h * 4);
    });

    it('BC7 纯色 round-trip 应接近无损', () => {
      const w = 4,
        h = 4;
      const orig = createSolidImage(w, h, 200, 100, 50);
      const encoded = encodeTexture(orig, w, h, TF.BC7);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.BC7, 'test');
      for (let i = 0; i < w * h * 4; i += 4) {
        expect(Math.abs(decoded[i] - 200)).toBeLessThanOrEqual(8);
        expect(Math.abs(decoded[i + 1] - 100)).toBeLessThanOrEqual(8);
        expect(Math.abs(decoded[i + 2] - 50)).toBeLessThanOrEqual(8);
        expect(decoded[i + 3]).toBe(255);
      }
    });

    it('ASTC 4x4 编码后大小正确（16 bytes/block）', () => {
      const orig = createTestImage(8, 8);
      const encoded = encodeTexture(orig, 8, 8, TF.ASTC_RGB_4x4);
      expect(encoded.length).toBe(64);
    });

    it('ASTC 4x4 round-trip 解码后尺寸正确', () => {
      const w = 8,
        h = 8;
      const orig = createTestImage(w, h);
      const encoded = encodeTexture(orig, w, h, TF.ASTC_RGB_4x4);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.ASTC_RGB_4x4, 'test');
      expect(decoded.length).toBe(w * h * 4);
    });

    it('ASTC 4x4 纯色 round-trip 应接近无损', () => {
      const w = 4,
        h = 4;
      const orig = createSolidImage(w, h, 200, 100, 50);
      const encoded = encodeTexture(orig, w, h, TF.ASTC_RGBA_4x4);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.ASTC_RGBA_4x4, 'test');
      // void extent 模式纯色应几乎无损
      for (let i = 0; i < w * h * 4; i += 4) {
        expect(Math.abs(decoded[i] - 200)).toBeLessThanOrEqual(16);
        expect(Math.abs(decoded[i + 1] - 100)).toBeLessThanOrEqual(16);
        expect(Math.abs(decoded[i + 2] - 50)).toBeLessThanOrEqual(16);
      }
    });

    it('ASTC 6x6 编码后大小正确（16 bytes/block）', () => {
      const orig = createTestImage(12, 12);
      const encoded = encodeTexture(orig, 12, 12, TF.ASTC_RGB_6x6);
      // ceil(12/6) * ceil(12/6) = 4 blocks, 16 bytes each
      expect(encoded.length).toBe(64);
    });

    it('ASTC 6x6 纯色 round-trip 应接近无损', () => {
      const w = 6,
        h = 6;
      const orig = createSolidImage(w, h, 200, 100, 50);
      const encoded = encodeTexture(orig, w, h, TF.ASTC_RGB_6x6);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.ASTC_RGB_6x6, 'test');
      expect(decoded.length).toBe(w * h * 4);
      for (let i = 0; i < w * h * 4; i += 4) {
        expect(Math.abs(decoded[i] - 200)).toBeLessThanOrEqual(16);
        expect(Math.abs(decoded[i + 1] - 100)).toBeLessThanOrEqual(16);
        expect(Math.abs(decoded[i + 2] - 50)).toBeLessThanOrEqual(16);
      }
    });

    it('ASTC 6x6 非整数块尺寸正确处理', () => {
      // 692x880: ceil(692/6)=116 blocks, ceil(880/6)=147 blocks
      const w = 692,
        h = 880;
      const orig = createSolidImage(w, h, 128, 64, 32);
      const encoded = encodeTexture(orig, w, h, TF.ASTC_RGB_6x6);
      expect(encoded.length).toBe(116 * 147 * 16);
    });

    it('ASTC 6x6 渐变图像 2-端点模式比纯色模式误差更小', () => {
      // 创建一个有渐变的 12x12 图像（4 个 6x6 块）
      const w = 12, h = 12;
      const orig = createTestImage(w, h);
      const encoded = encodeTexture(orig, w, h, TF.ASTC_RGB_6x6);
      const decoded = decodeTexture(new Uint8Array(encoded), w, h, TF.ASTC_RGB_6x6, 'test');

      // 计算平均误差
      let totalError = 0;
      for (let i = 0; i < w * h * 4; i += 4) {
        const origIdx = i;
        totalError += Math.abs(decoded[i] - orig[origIdx]);
        totalError += Math.abs(decoded[i + 1] - orig[origIdx + 1]);
        totalError += Math.abs(decoded[i + 2] - orig[origIdx + 2]);
      }
      const avgError = totalError / (w * h * 3);

      // 2-端点模式应将平均误差控制在合理范围
      // void-extent 在 6x6 块上平均误差约 60-80，2-端点应 < 40
      expect(avgError).toBeLessThan(40);
    });

    it('DXT1 编码后大小正确（8 bytes/block）', () => {
      const orig = createTestImage(8, 8);
      const encoded = encodeTexture(orig, 8, 8, TF.DXT1);
      expect(encoded.length).toBe(32);
    });

    it('不支持的格式应抛出错误', () => {
      const orig = createTestImage(4, 4);
      expect(() => encodeTexture(orig, 4, 4, TF.BC4)).toThrow('encoder is not implemented');
    });

    it('非 4 的倍数尺寸也能编码', () => {
      const orig = createTestImage(5, 7);
      const encoded = encodeTexture(orig, 5, 7, TF.BC7);
      // ceil(5/4) × ceil(7/4) = 2 × 2 = 4 blocks × 16 = 64
      expect(encoded.length).toBe(64);
    });
  });

  describe('isFormatSupported', () => {
    it('支持的格式返回 true', () => {
      expect(isFormatSupported(TF.RGBA32)).toBe(true);
      expect(isFormatSupported(TF.DXT5)).toBe(true);
      expect(isFormatSupported(TF.BC7)).toBe(true);
      expect(isFormatSupported(TF.ASTC_RGB_4x4)).toBe(true);
      expect(isFormatSupported(TF.ASTC_RGBA_4x4)).toBe(true);
      expect(isFormatSupported(TF.ASTC_RGB_6x6)).toBe(true);
      expect(isFormatSupported(TF.ASTC_RGBA_6x6)).toBe(true);
      expect(isFormatSupported(TF.ASTC_RGB_8x8)).toBe(true);
      expect(isFormatSupported(TF.DXT1)).toBe(true);
      expect(isFormatSupported(TF.BGRA32)).toBe(true);
    });

    it('不支持的格式返回 false', () => {
      expect(isFormatSupported(TF.BC4)).toBe(false);
      expect(isFormatSupported(TF.BC5)).toBe(false);
      expect(isFormatSupported(TF.BC6H)).toBe(false);
    });
  });

  describe('getSupportedFormats', () => {
    it('返回所有支持的格式', () => {
      const formats = getSupportedFormats();
      expect(formats).toContain(TF.RGBA32);
      expect(formats).toContain(TF.DXT5);
      expect(formats).toContain(TF.BC7);
      expect(formats).toContain(TF.ASTC_RGB_4x4);
      expect(formats.length).toBeGreaterThanOrEqual(7);
    });
  });
});
