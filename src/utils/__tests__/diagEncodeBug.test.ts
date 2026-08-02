import { describe, it, expect } from 'vitest';
import { encodeTextureWithMips, encodeTexture } from '../textureEncoder';
import { TextureFormat as TF } from '@arkntools/unity-js';

describe('diagnose: encodeTextureWithMips 截断 bug', () => {
  it('baseEncoded 超过 targetSize 时被截断（模拟导入更大图片+mipmaps）', () => {
    // 原始纹理 512x512 ASTC 4x4 含 mipmaps → total ~349440
    // 用户导入 1024x1024 → baseEncoded = 1048576
    const rgba = new Uint8Array(1024 * 1024 * 4);
    const baseEncoded = encodeTexture(rgba, 1024, 1024, TF.ASTC_RGBA_4x4);
    console.log('baseEncoded.length:', baseEncoded.length);

    const targetSize = 349440; // 原始大小（含 mipmaps）
    const result = encodeTextureWithMips(rgba, 1024, 1024, TF.ASTC_RGBA_4x4, targetSize);

    console.log('result.length:', result.length);
    console.log('baseEncoded.length >= targetSize?', baseEncoded.length >= targetSize);
    console.log('result.length === targetSize?', result.length === targetSize);

    // 当前 bug: 当 baseEncoded >= targetSize 时，结果被截断到 targetSize
    // 但解码器期望 baseEncoded.length 字节（完整的 base level）
    // 这导致 "Not enough data to decode image!"
    if (result.length === targetSize && targetSize < baseEncoded.length) {
      console.log('BUG 确认: 结果被截断到 targetSize，丢失了', baseEncoded.length - targetSize, '字节');
    }
    expect(true).toBe(true);
  });

  it('baseEncoded 小于 targetSize 时正常（mipmap 填充）', () => {
    const rgba = new Uint8Array(256 * 256 * 4);
    const baseEncoded = encodeTexture(rgba, 256, 256, TF.ASTC_RGBA_4x4);
    console.log('baseEncoded.length:', baseEncoded.length);

    const targetSize = 349440;
    const result = encodeTextureWithMips(rgba, 256, 256, TF.ASTC_RGBA_4x4, targetSize);

    console.log('result.length:', result.length);
    console.log('result.length === targetSize?', result.length === targetSize);
    // 这个应该正常：baseEncoded < targetSize，mipmap 填充到 targetSize
    expect(result.length).toBe(targetSize);
  });
});