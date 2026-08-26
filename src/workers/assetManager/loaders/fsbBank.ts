import { AssetType } from '@arkntools/unity-js';
import { PreviewType, type FsbSampleMeta } from '@/types/preview';
import type { PreviewInfo } from './default';
import type { AssetInfo } from '../index';
import { FSB5_FREQ_TABLE } from './fsbWriter';

/**
 * FSB5 解析与「独立 bank 文件」资产注入。
 *
 * 设计要点：
 * - 解析阶段只读取头部元数据（子音频名/声道/采样率/时长/编码），纯 JS，无 WASM 依赖。
 * - 实际解码每个子音频由主线程的 FMOD WASM 完成（见 src/utils/fsbDecode.ts），
 *   本文件只产出「合成 AudioClip 对象」交给现有 AudioClipLoader 走统一预览/导出管线。
 *
 * FSB5 文件头布局（来自 oggvorbis2fsb5.c 的权威结构）：
 *   offset 0  : 'FSB5' (uint32 magic 0x35425346)
 *   offset 4  : version (uint32)
 *   offset 8  : numSamples (uint32)
 *   offset 12 : sampleHeaderSize (uint32)
 *   offset 16 : nameTableSize (uint32)
 *   offset 20 : dataSize (uint32)
 *   offset 24 : mode (uint32, 编码 hint)
 *   offset 28 : zero[8]
 *   offset 36 : hash[16]  (FMOD 不校验，可忽略)
 *   offset 52 : dummy[8]
 *   => 头部共 60 字节
 * 样本元数据表紧跟其后，共 sampleHeaderSize 字节；其后是 nameTable（nameTableSize）；再是样本数据。
 *
 * 每个样本 8 字节 bitfield：
 *   extra_param : 1
 *   frequency   : 4   (采样率索引，见 FSB5_FREQ_TABLE，0 表示需用 extra 频率块)
 *   channels    : 2   (0=1ch 1=2ch；>2 声道由 extra chunk type 1 给出精确值)
 *   dataOffset  : 27  (真实字节偏移 = dataOffset * 32，32 字节对齐)
 *   samples     : 30  (PCM 帧数，用于算时长)
 * 之后是一串 extra header（has_next:1 / size:24 / chunk_type:7），chunk_type:
 *   1=声道数 2=采样率 3=循环 11=Vorbis 数据(crc32+seek table) 13=峰值音量。
 */

const FSB5_MAGIC = 0x35425346; // 'FSB5'

export interface FsbBankParseResult {
  fsbBytes: Uint8Array;
  samples: FsbSampleMeta[];
}

/** 在文件前 2MB 内查找 FSB5 magic，返回起始偏移；找不到返回 -1 */
const findFsbOffset = (bytes: Uint8Array): number => {
  const searchLen = Math.min(bytes.length, 2 * 1024 * 1024);
  for (let i = 0; i + 4 <= searchLen; i++) {
    if (
      bytes[i] === 0x46 && // F
      bytes[i + 1] === 0x53 && // S
      bytes[i + 2] === 0x42 && // B
      bytes[i + 3] === 0x35 // 5
    ) {
      return i;
    }
  }
  return -1;
};

/**
 * 判断给定文件是否为独立的 FSB5 bank。
 * - 头部 4 字节直接是 FSB5：裸 FSB5（Unity AudioClip 内嵌的就是这种）。
 * - 扩展名 .fsb/.bank/.fsb5 且前 2MB 内能找到 FSB5 magic：RIFF 包装 / FMOD Studio .bank 内嵌 FSB5。
 * 返回 FSB 数据的起始偏移；不是则返回 null。
 */
export const detectFsbBank = (bytes: Uint8Array, fileName: string): number | null => {
  if (bytes.length >= 4 && bytes[0] === 0x46 && bytes[1] === 0x53 && bytes[2] === 0x42 && bytes[3] === 0x35) {
    return 0;
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.fsb') || lower.endsWith('.fsb5') || lower.endsWith('.bank')) {
    const off = findFsbOffset(bytes);
    if (off >= 0) return off;
  }
  return null;
};

const parseNames = (bytes: Uint8Array, start: number, size: number, count: number): string[] => {
  const names: string[] = [];
  const decoder = new TextDecoder();
  // FSB5 名字表格式：前 count*4 字节是 uint32 偏移数组，每个偏移相对 nameTable 起点，
  // 指向一条以 null 结尾的名字字符串；之后才是真正的字符串数据。
  for (let i = 0; i < count; i++) {
    const off =
      (bytes[start + i * 4] |
        (bytes[start + i * 4 + 1] << 8) |
        (bytes[start + i * 4 + 2] << 16) |
        (bytes[start + i * 4 + 3] << 24)) >>>
      0;
    const strStart = start + off;
    const strEnd = start + size;
    let s = strStart;
    while (s < strEnd && bytes[s] !== 0) s++;
    names.push(s > strStart ? decoder.decode(bytes.subarray(strStart, s)) : '');
  }
  return names;
};

/**
 * 解析 FSB5 头部，返回截取的 FSB 字节 + 每个子音频元数据。
 * 不含解码（解码在主线程 FMOD）。
 * @param knownOffset 可选：FSB5 magic 在文件中的起始偏移（由 detectFsbBank 预先得到）。
 *                     不传则仅在偏移 0 处识别裸 FSB5。
 */
export const parseFsbBank = (fileBytes: Uint8Array, knownOffset?: number | null): FsbBankParseResult | null => {
  const offset = knownOffset != null ? knownOffset : detectFsbBank(fileBytes, '');
  if (offset === null || offset < 0) return null;
  const bytes = offset === 0 ? fileBytes : fileBytes.subarray(offset);
  if (bytes.length < 60) return null;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== FSB5_MAGIC) return null;

  const version = dv.getUint32(4, true);
  const numSamples = dv.getUint32(8, true);
  const sampleHeaderSize = dv.getUint32(12, true);
  const nameTableSize = dv.getUint32(16, true);
  const mode = dv.getUint32(24, true);

  let off = 60;
  const sampleHeaderEnd = 60 + sampleHeaderSize;
  const samples: FsbSampleMeta[] = [];
  for (let i = 0; i < numSamples; i++) {
    if (off + 8 > sampleHeaderEnd) break; // 守卫：防止 extra header 越界污染后续样本
    const sh = dv.getBigUint64(off, true);
    off += 8;
    const extraParam = Number(sh & 1n);
    const freqIdx = Number((sh >> 1n) & 0xFn);
    // channels 是 2 bit（bit5..6），不是 1 bit stereo；dataOffset 从 bit7 起占 27 位。
    // 真实 98 样本 bank 已实证此布局。
    const chBits = Number((sh >> 5n) & 0x3n);
    const sampleCount = Number((sh >> 34n) & 0x3FFFFFFFn);

    let channels = chBits + 1;
    let frequency = FSB5_FREQ_TABLE[freqIdx] ?? 0;

    // 遍历 extra header 链。bitfield 的 extra_param 位为 0 表示本样本无 extra chunk，
    // 头部仅 8 字节（PCM16 简单样本即如此）；不为 0 才进入链。
    if (extraParam) {
      let guard = 0;
      while (guard++ < 64) {
        if (off + 4 > sampleHeaderEnd) break;
        const eh = dv.getUint32(off, true);
        off += 4;
        const hasNext = eh & 1;
        const size = (eh >> 1) & 0xffffff;
        const chunkType = (eh >> 25) & 0x7f;
        if (chunkType === 1) {
          channels = dv.getUint8(off);
        } else if (chunkType === 2) {
          frequency = dv.getUint32(off, true);
        }
        off += size;
        if (!hasNext) break;
      }
    }

    const duration = frequency > 0 ? sampleCount / frequency : 0;
    samples.push({
      index: i,
      name: '',
      channels,
      frequency,
      duration,
      sampleCount,
      mode,
    });
  }

  // 解析 name table（紧跟样本元数据表）
  const nameTableStart = 60 + sampleHeaderSize;
  if (nameTableSize > 0 && nameTableStart + nameTableSize <= bytes.length) {
    const names = parseNames(bytes, nameTableStart, nameTableSize, numSamples);
    samples.forEach((s, i) => {
      s.name = names[i] || `sample_${i}`;
    });
  } else {
    samples.forEach((s, i) => {
      s.name = `sample_${i}`;
    });
  }

  void version;

  return { fsbBytes: bytes, samples };
};

/** 构造一个「伪装成 AudioClip」的轻量对象，供 AudioClipLoader 走统一管线 */
export const makeFsbSampleObject = (
  fsbBytes: Uint8Array,
  meta: FsbSampleMeta,
): any => ({
  type: AssetType.AudioClip,
  pathId: BigInt(meta.index),
  name: meta.name,
  format: 'fsb',
  __fsbSubIndex: meta.index,
  getAudio: () => ({
    format: 'fsb',
    size: fsbBytes.length,
    channels: meta.channels,
    sampleRate: meta.frequency,
    data: fsbBytes,
  }),
  getTypeTree: () => ({}),
  dump: () => ({ ...meta }),
});

/**
 * 把一个独立 FSB bank 拆成资产列表：
 * - 每个子音频 → 一条 AudioClip 资产（走 AudioClipLoader，可预览/导出 WAV）。
 * - 整个 bank → 一条 FsbBank 资产（不可导出，预览时列出全部子音频逐个播放）。
 */
export const createFsbAssetInfos = (
  fileId: string,
  fileName: string,
  fsbBytes: Uint8Array,
  samples: FsbSampleMeta[],
): AssetInfo[] => {
  const infos: AssetInfo[] = [];

  for (const meta of samples) {
    const preview: PreviewInfo = {
      type: PreviewType.Audio,
      typeTree: {},
      inspect: { ...meta },
    } as PreviewInfo;
    infos.push({
      key: `${fileId}_fsb_${meta.index}`,
      fileId,
      fileName,
      name: meta.name,
      container: fileName,
      type: 'AudioClip',
      pathId: BigInt(meta.index),
      size: 0,
      preview,
      canExport: true,
      search: [meta.name, fileName, 'fsb'],
    });
  }

  const bankPreview: PreviewInfo = {
    type: PreviewType.FsbBank,
    typeTree: {},
    inspect: {},
    samples,
  } as PreviewInfo;
  infos.push({
    key: `${fileId}_fsbbank`,
    fileId,
    fileName,
    name: `${fileName} (bank)`,
    container: '',
    type: 'FsbBank',
    pathId: BigInt(-1),
    size: fsbBytes.length,
    preview: bankPreview,
    canExport: true,
    search: [fileName, 'bank', 'fsb'],
  });

  return infos;
};
