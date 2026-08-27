import {
  decodeAstc,
  decodeAtcRgb4,
  decodeAtcRgba8,
  decodeBc1,
  decodeBc3,
  decodeBc4,
  decodeBc5,
  decodeBc6Unsigned,
  decodeBc7,
  decodeEacr,
  decodeEacrg,
  decodeEacrgSigned,
  decodeEacrSigned,
  decodeEtc1,
  decodeEtc2Rgb,
  decodeEtc2Rgba1,
  decodePvrtc2bpp,
  decodePvrtc4bpp,
} from '@arkntools/unity-js-tools-wasm';
// decodeEtc2Rgba8 使用项目内移植的 alpha 补丁（见 etc2Patch.ts）
import { decodeEtc2Rgba8 } from './etc2Patch';
import { TextureFormat as TF } from '../classes/types';

type DecodeFunction = (
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
) => Uint8Array<ArrayBufferLike>;

const getAstcDecodeFunc =
  (blockSize: number): DecodeFunction =>
  (...args) =>
    decodeAstc(...args, blockSize, blockSize);

// ---- Uncompressed format decoders ----
// All output BGRA byte order, matching UABEA's RGBADecoders.cs.
// The existing bgra2rgba() post-step converts BGRA -> RGBA.
const decodeAlpha8: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j++) {
    out[i] = 0xff;     // B
    out[i + 1] = 0xff; // G
    out[i + 2] = 0xff; // R
    out[i + 3] = data[j]; // A
  }
  return out;
};

const decodeARGB4444: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 2) {
    const b0 = data[j];
    const b1 = data[j + 1];
    // ARGB layout: byte1 hi=A, byte1 lo=R, byte0 hi=G, byte0 lo=B
    const a = b1 >> 4;
    const r = b1 & 0xf;
    const g = b0 >> 4;
    const b = b0 & 0xf;
    out[i] = (b << 4) | b;       // B
    out[i + 1] = (g << 4) | g;   // G
    out[i + 2] = (r << 4) | r;   // R
    out[i + 3] = (a << 4) | a;   // A
  }
  return out;
};

const decodeRGB24: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    out[i] = data[j + 2];     // B
    out[i + 1] = data[j + 1]; // G
    out[i + 2] = data[j];     // R
    out[i + 3] = 0xff;        // A
  }
  return out;
};

const decodeARGB32: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 4) {
    out[i] = data[j + 2];     // B
    out[i + 1] = data[j + 1]; // G
    out[i + 2] = data[j];     // R
    out[i + 3] = data[j + 3]; // A
  }
  return out;
};

const decodeRGB565: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 2) {
    const v = data[j] | (data[j + 1] << 8); // little-endian 16-bit
    let r = (v >> 11) & 0x1f; r = (r << 3) | (r >> 2);
    let g = (v >> 5) & 0x3f;  g = (g << 2) | (g >> 4);
    let b = v & 0x1f;         b = (b << 3) | (b >> 2);
    out[i] = b;       // B
    out[i + 1] = g;   // G
    out[i + 2] = r;   // R
    out[i + 3] = 0xff; // A
  }
  return out;
};

const decodeRGBA4444: DecodeFunction = (data, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 2) {
    const b0 = data[j];
    const b1 = data[j + 1];
    // RGBA layout: byte1 hi=R, byte1 lo=G, byte0 hi=B, byte0 lo=A
    const r = b1 >> 4;
    const g = b1 & 0xf;
    const b = b0 >> 4;
    const a = b0 & 0xf;
    out[i] = (b << 4) | b;       // B
    out[i + 1] = (g << 4) | g;   // G
    out[i + 2] = (r << 4) | r;   // R
    out[i + 3] = (a << 4) | a;   // A
  }
  return out;
};

// BGRA32: raw data is already in BGRA byte order; just copy through.
const decodeBGRA32: DecodeFunction = (data, w, h) => {
  return new Uint8Array(data);
};

const funcMap: Partial<Record<TF, DecodeFunction>> = {
  [TF.ATC_RGB4]: decodeAtcRgb4,
  [TF.ATC_RGBA8]: decodeAtcRgba8,
  [TF.ASTC_RGB_4x4]: getAstcDecodeFunc(4),
  [TF.ASTC_RGB_5x5]: getAstcDecodeFunc(5),
  [TF.ASTC_RGB_6x6]: getAstcDecodeFunc(6),
  [TF.ASTC_RGB_8x8]: getAstcDecodeFunc(8),
  [TF.ASTC_RGB_10x10]: getAstcDecodeFunc(10),
  [TF.ASTC_RGB_12x12]: getAstcDecodeFunc(12),
  [TF.ASTC_RGBA_4x4]: getAstcDecodeFunc(4),
  [TF.ASTC_RGBA_5x5]: getAstcDecodeFunc(5),
  [TF.ASTC_RGBA_6x6]: getAstcDecodeFunc(6),
  [TF.ASTC_RGBA_8x8]: getAstcDecodeFunc(8),
  [TF.ASTC_RGBA_10x10]: getAstcDecodeFunc(10),
  [TF.ASTC_RGBA_12x12]: getAstcDecodeFunc(12),
  [TF.ASTC_HDR_4x4]: getAstcDecodeFunc(4),
  [TF.ASTC_HDR_5x5]: getAstcDecodeFunc(5),
  [TF.ASTC_HDR_6x6]: getAstcDecodeFunc(6),
  [TF.ASTC_HDR_8x8]: getAstcDecodeFunc(8),
  [TF.ASTC_HDR_10x10]: getAstcDecodeFunc(10),
  [TF.ASTC_HDR_12x12]: getAstcDecodeFunc(12),
  [TF.DXT1]: decodeBc1,
  [TF.DXT5]: decodeBc3,
  [TF.BC4]: decodeBc4,
  [TF.BC5]: decodeBc5,
  [TF.BC6H]: decodeBc6Unsigned, // not sure
  [TF.BC7]: decodeBc7,
  [TF.ETC_RGB4]: decodeEtc1,
  [TF.ETC_RGB4_3DS]: decodeEtc1,
  [TF.ETC2_RGB]: decodeEtc2Rgb,
  [TF.ETC2_RGBA1]: decodeEtc2Rgba1,
  [TF.ETC2_RGBA8]: decodeEtc2Rgba8,
  [TF.EAC_R]: decodeEacr,
  [TF.EAC_R_SIGNED]: decodeEacrSigned,
  [TF.EAC_RG]: decodeEacrg,
  [TF.EAC_RG_SIGNED]: decodeEacrgSigned,
  [TF.PVRTC_RGB2]: decodePvrtc2bpp,
  [TF.PVRTC_RGBA2]: decodePvrtc2bpp,
  [TF.PVRTC_RGB4]: decodePvrtc4bpp,
  [TF.PVRTC_RGBA4]: decodePvrtc4bpp,
  [TF.Alpha8]: decodeAlpha8,
  [TF.ARGB4444]: decodeARGB4444,
  [TF.RGB24]: decodeRGB24,
  [TF.ARGB32]: decodeARGB32,
  [TF.RGB565]: decodeRGB565,
  [TF.RGBA4444]: decodeRGBA4444,
  [TF.BGRA32]: decodeBGRA32,
} as any;

const bgra2rgba = (data: Uint8Array<ArrayBuffer>) => {
  for (let i = 0; i + 3 < data.length; i += 4) {
    [data[i], data[i + 2]] = [data[i + 2], data[i]];
  }
  return data;
};

export const decodeTexture = (
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  format: TF,
  name: string,
) => {
  if (format === TF.RGBA32) return data;
  const decodeFunc = funcMap[format];
  if (!decodeFunc) {
    throw new Error(`Texture2d format "${format}" decoder is not implemented. (${name})`);
  }
  return bgra2rgba(decodeFunc(data, width, height) as Uint8Array<ArrayBuffer>);
};
