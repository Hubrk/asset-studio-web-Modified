/**
 * FSB5「增量重打包」：未修改的样本原封不动搬字节，只有被替换的样本重新编码。
 *
 * 为什么要这么做（对比旧的全量 PCM16 重编码）：
 *   1. 体积。全量转 PCM16 会让 1.5MB 的 bank 涨到 30MB+；用 FSBank 全量重编 Vorbis 也会到 6.8MB
 *      （因为 FSBank 默认 quality≈0.9，而原 bank 是 0.15）。增量重打包只动一条样本，
 *      实测 1,567,808B → 1,521,869B，不升反降。
 *   2. 保真。没被用户改的 97 条样本是字节级原样，音质零损失、风险为零。
 *   3. 兼容。替换样本用 libvorbis 编码，并自动挑选让 setup 包 CRC32 命中「原 bank 里已经在用的值」的
 *      quality——既然原 bank 能播，说明 FMOD 内置 codebook 表里有这个 CRC，那新样本也一定能播。
 *
 * FSB5 结构（经真实 98 样本 bank 全量实证）：
 *   [60B 头][样本头区(16B 对齐)][名字表][数据区(每样本 32B 对齐)]
 *   样本头 8 字节 bitfield（LSB 起）：extra_param:1 | frequency:4 | channels:2 | dataOffset:27 | samples:30
 *     真实字节偏移 = dataOffset * 32
 *   extra chunk 链头 4 字节：has_next:1 | size:24 | chunk_type:7
 *     type 1=channels, 2=frequency, 3=loop(2×u32), 11=VORBISDATA, 13=peak volume
 *   type-11 体：{u32 setupCrc32}{u32 seekTableBytes}{N × {u32 granulepos, u32 数据区内字节偏移}}
 *   Vorbis 数据区：[u16 packetLen][packet] 链，尾部补 0 到 32B 对齐（读到 len==0 即结束）
 */

import { FSB5_FREQ_TABLE, FSB5_MODE_VORBIS, FSB5_MODE_PCM16 } from './fsbWriter';
import { parseFsbBank } from './fsbBank';
import {
  downmixToMono,
  encodeVorbisOgg,
  interleavedPcm16ToChannels,
  upmixToStereo,
} from './vorbisEncoder';

const FSB5_MAGIC = 0x35425346; // 'FSB5'

// ---------------------------------------------------------------- 基础工具

const concat = (arrs: Uint8Array[]): Uint8Array => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
};

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 标准 CRC-32（poly 0xEDB88320），FMOD 用它索引内置 Vorbis codebook */
export const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

// ---------------------------------------------------------------- Ogg 拆包

interface OggPage {
  granulePos: number;
  packets: Uint8Array[];
}

/** 把 Ogg 字节流拆成页与其中的完整包（跨页续传的包会在结束页归并） */
export const parseOggPages = (bytes: Uint8Array): OggPage[] => {
  const pages: OggPage[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 27 <= bytes.length) {
    if (bytes[off] !== 0x4f || bytes[off + 1] !== 0x67 || bytes[off + 2] !== 0x67 || bytes[off + 3] !== 0x53) {
      break; // 'OggS'
    }
    const granulePos = Number(dv.getBigUint64(off + 6, true));
    const segCount = bytes[off + 26];
    const segTable = bytes.subarray(off + 27, off + 27 + segCount);
    const dataOff = off + 27 + segCount;
    let pageLen = 0;
    for (let i = 0; i < segCount; i++) pageLen += segTable[i];
    const pageData = bytes.subarray(dataOff, dataOff + pageLen);

    const packets: Uint8Array[] = [];
    let pending: Uint8Array[] = [];
    let p = 0;
    for (let i = 0; i < segCount; i++) {
      const l = segTable[i];
      pending.push(pageData.subarray(p, p + l));
      p += l;
      if (l < 255) {
        packets.push(pending.length === 1 ? pending[0] : concat(pending));
        pending = [];
      }
    }
    pages.push({ granulePos, packets });
    off = dataOff + pageLen;
  }
  return pages;
};

// ---------------------------------------------------------------- FSB5 解析

export interface FsbRawChunk {
  type: number;
  data: Uint8Array;
}

export interface FsbRawSample {
  index: number;
  name: string;
  freqIdx: number;
  chBits: number;
  channels: number;
  sampleRate: number;
  frameCount: number;
  dataOffset: number;
  vorbisCrc: number | null;
  chunks: FsbRawChunk[];
  /** extra chunk 链的完整原始字节（可直接照搬） */
  extraRaw: Uint8Array;
  /** 该样本在数据区的原始字节（含尾部对齐填充） */
  dataRaw: Uint8Array;
}

export interface FsbRawBank {
  version: number;
  mode: number;
  /** 60 字节头里 zero[8]+hash[16]+dummy[8] 这 32 字节，原样保留 */
  tail: Uint8Array;
  samples: FsbRawSample[];
}

/** 解析 FSB5，保留每个样本的原始字节切片，供增量重打包直接复用 */
export const parseFsb5Raw = (fsb: Uint8Array): FsbRawBank => {
  const dv = new DataView(fsb.buffer, fsb.byteOffset, fsb.byteLength);
  if (fsb.length < 60 || dv.getUint32(0, true) !== FSB5_MAGIC) {
    throw new Error('parseFsb5Raw: 不是合法的 FSB5');
  }
  const version = dv.getUint32(4, true);
  const numSamples = dv.getUint32(8, true);
  const sampleHeaderSize = dv.getUint32(12, true);
  const nameTableSize = dv.getUint32(16, true);
  const dataSize = dv.getUint32(20, true);
  const mode = dv.getUint32(24, true);
  const tail = fsb.subarray(28, 60);

  const shStart = 60;
  const shEnd = shStart + sampleHeaderSize;
  const ntStart = shEnd;
  const dStart = ntStart + nameTableSize;

  const samples: FsbRawSample[] = [];
  let off = shStart;
  for (let i = 0; i < numSamples; i++) {
    if (off + 8 > shEnd) throw new Error(`parseFsb5Raw: 样本头越界 @${i}`);
    const lo = dv.getUint32(off, true);
    const hi = dv.getUint32(off + 4, true);
    const extraParam = lo & 1;
    const freqIdx = (lo >>> 1) & 0xf;
    const chBits = (lo >>> 5) & 0x3;
    // dataOffset 是 27 位：低 25 位在 lo 的 bit7..31，高 2 位在 hi 的 bit0..1；单位 32 字节
    const dataOffset = (((lo >>> 7) | ((hi & 0x3) << 25)) >>> 0) * 32;
    const frameCount = hi >>> 2;
    const extraStart = off + 8;
    off += 8;

    const chunks: FsbRawChunk[] = [];
    if (extraParam) {
      let guard = 0;
      let more = true;
      while (more && guard++ < 64) {
        if (off + 4 > shEnd) throw new Error(`parseFsb5Raw: extra chunk 越界 @${i}`);
        const c = dv.getUint32(off, true);
        off += 4;
        more = (c & 1) !== 0;
        const size = (c >>> 1) & 0xffffff;
        const type = (c >>> 25) & 0x7f;
        chunks.push({ type, data: fsb.subarray(off, off + size) });
        off += size;
      }
    }

    let channels = chBits + 1;
    let sampleRate = FSB5_FREQ_TABLE[freqIdx] ?? 0;
    let vorbisCrc: number | null = null;
    for (const c of chunks) {
      const cdv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
      if (c.type === 1 && c.data.length >= 1) channels = c.data[0];
      else if (c.type === 2 && c.data.length >= 4) sampleRate = cdv.getUint32(0, true);
      else if (c.type === 11 && c.data.length >= 4) vorbisCrc = cdv.getUint32(0, true);
    }

    samples.push({
      index: i,
      name: '',
      freqIdx,
      chBits,
      channels,
      sampleRate,
      frameCount,
      dataOffset,
      vorbisCrc,
      chunks,
      extraRaw: fsb.subarray(extraStart, off),
      dataRaw: new Uint8Array(0), // 下面按相邻偏移切
    });
  }

  // 名字表：count×4 的 uint32 偏移数组 + null 结尾字符串，偏移相对名字表起点
  if (nameTableSize > 0 && ntStart + nameTableSize <= fsb.length) {
    for (let i = 0; i < numSamples; i++) {
      const so = dv.getUint32(ntStart + i * 4, true);
      let p = ntStart + so;
      const end = Math.min(ntStart + nameTableSize, fsb.length);
      let q = p;
      while (q < end && fsb[q] !== 0) q++;
      samples[i].name = new TextDecoder().decode(fsb.subarray(p, q));
    }
  }
  samples.forEach((s, i) => {
    if (!s.name) s.name = `sample_${i}`;
  });

  // 数据切片：本样本 offset 到下一样本 offset（末尾用 dataSize），含对齐填充
  for (let i = 0; i < samples.length; i++) {
    const end = i + 1 < samples.length ? samples[i + 1].dataOffset : dataSize;
    samples[i].dataRaw = fsb.subarray(dStart + samples[i].dataOffset, Math.min(dStart + end, fsb.length));
  }

  return { version, mode, tail, samples };
};

// ---------------------------------------------------------------- 重建

/** 构造 extra chunk（4 字节头 + 体） */
const buildExtraChunk = (type: number, body: Uint8Array, hasNext: boolean): Uint8Array => {
  const hdr = new Uint8Array(4);
  let v = 0;
  if (hasNext) v |= 1;
  v |= (body.length & 0xffffff) << 1;
  v |= type << 25;
  new DataView(hdr.buffer).setUint32(0, v >>> 0, true);
  return concat([hdr, body]);
};

/** 一个样本在重建时的最终形态 */
interface RebuildSample {
  name: string;
  freqIdx: number;
  chBits: number;
  frameCount: number;
  extraRaw: Uint8Array;
  dataRaw: Uint8Array;
}

/** 按 FSB5 规范重新拼装整个文件（样本顺序与元数据由入参决定） */
export const rebuildFsb5 = (bank: Pick<FsbRawBank, 'version' | 'mode' | 'tail'>, list: RebuildSample[]): Uint8Array => {
  const shParts: Uint8Array[] = [];
  const dataParts: Uint8Array[] = [];
  let cursor = 0;

  for (const s of list) {
    // 8 字节 bitfield：extra:1 | freq:4 | channels:2 | dataOffset:27 | samples:30
    let field = 0n;
    if (s.extraRaw.length > 0) field |= 1n;
    field |= BigInt(s.freqIdx & 0xf) << 1n;
    field |= BigInt(s.chBits & 0x3) << 5n;
    field |= BigInt((cursor / 32) & 0x07ffffff) << 7n;
    field |= BigInt(s.frameCount & 0x3fffffff) << 34n;
    const base8 = new Uint8Array(8);
    new DataView(base8.buffer).setBigUint64(0, field, true);
    shParts.push(base8, s.extraRaw);

    const aligned = Math.ceil(s.dataRaw.length / 32) * 32;
    const blk = new Uint8Array(aligned);
    blk.set(s.dataRaw, 0);
    dataParts.push(blk);
    cursor += aligned;
  }

  const shRegion = concat(shParts);
  const shPad = (16 - ((60 + shRegion.length) % 16)) % 16;

  const encoder = new TextEncoder();
  const bodies = list.map((s) => {
    const b = encoder.encode(s.name);
    const a = new Uint8Array(b.length + 1);
    a.set(b);
    return a;
  });
  const offBuf = new Uint8Array(list.length * 4);
  const odv = new DataView(offBuf.buffer);
  let cur = list.length * 4;
  bodies.forEach((b, i) => {
    odv.setUint32(i * 4, cur, true);
    cur += b.length;
  });
  const nameTableCore = concat([offBuf, ...bodies]);
  // 数据区必须落在 32 字节边界上：样本头里 dataOffset 以 32B 为单位，
  // 且游戏装载管线对数据区起点做对齐校验（未对齐会整包拒读→全静音）。
  // 做法与 FSBank 一致：名字表尾部补零，把补零计入 nameTableSize。
  const ntPad = (32 - ((60 + shRegion.length + shPad + nameTableCore.length) % 32)) % 32;
  const nameTable = ntPad === 0 ? nameTableCore : concat([nameTableCore, new Uint8Array(ntPad)]);

  const header = new Uint8Array(60);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, FSB5_MAGIC, true);
  hdv.setUint32(4, bank.version, true);
  hdv.setUint32(8, list.length, true);
  hdv.setUint32(12, shRegion.length + shPad, true);
  hdv.setUint32(16, nameTable.length, true);
  hdv.setUint32(20, cursor, true);
  hdv.setUint32(24, bank.mode >>> 0, true);
  header.set(bank.tail.subarray(0, 32), 28);

  return concat([header, shRegion, new Uint8Array(shPad), nameTable, ...dataParts]);
};

// ---------------------------------------------------------------- Ogg → FSB5 样本

export interface EncodedFsbSample {
  /** 数据区字节（[u16 len][packet] 链 + 32B 对齐填充） */
  data: Uint8Array;
  /** type-11 chunk 体 */
  body11: Uint8Array;
  setupCrc: number;
  totalFrames: number;
  packetCount: number;
}

/** 把标准 Ogg Vorbis 字节流转成 FSB5 数据区格式 + type-11(VORBISDATA) chunk 体 */
export const oggToFsbVorbisSample = (ogg: Uint8Array): EncodedFsbSample => {
  const pages = parseOggPages(ogg);
  const allPackets: Uint8Array[] = [];
  const pageFirstPacketIdx: number[] = [];
  for (const pg of pages) {
    pageFirstPacketIdx.push(allPackets.length);
    allPackets.push(...pg.packets);
  }
  if (allPackets.length < 4) throw new Error('oggToFsbVorbisSample: Ogg 包数不足（音频过短？）');

  const setupCrc = crc32(allPackets[2]); // 第 3 个包 = setup（codebook）
  const audioPackets = allPackets.slice(3);

  const parts: Uint8Array[] = [];
  const pktOffsets: number[] = [];
  let cursor = 0;
  for (const p of audioPackets) {
    pktOffsets.push(cursor);
    const hdr = new Uint8Array(2);
    new DataView(hdr.buffer).setUint16(0, p.length, true);
    parts.push(hdr, p);
    cursor += 2 + p.length;
  }
  const aligned = Math.ceil(cursor / 32) * 32;
  const data = new Uint8Array(aligned);
  {
    let q = 0;
    for (const p of parts) {
      data.set(p, q);
      q += p.length;
    }
  }

  // seek table：每个含音频包的 Ogg page 一条 {granulepos, 该 page 首个音频包在数据区的字节偏移}
  const tableParts: Uint8Array[] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const audioIdx = pageFirstPacketIdx[pi] - 3;
    if (audioIdx < 0 || audioIdx >= audioPackets.length) continue;
    const gp = pages[pi].granulePos;
    if (gp <= 0) continue;
    tableParts.push(u32le(gp), u32le(pktOffsets[audioIdx]));
  }
  const tableBytes = concat(tableParts);
  const body11 = concat([u32le(setupCrc), u32le(tableBytes.length), tableBytes]);

  const totalFrames = pages.length ? pages[pages.length - 1].granulePos : 0;
  return { data, body11, setupCrc, totalFrames, packetCount: audioPackets.length };
};

// ---------------------------------------------------------------- 高层：增量重打包

export interface FsbReplacementPcm {
  pcm: Int16Array;
  channels: number;
  sampleRate: number;
}

export interface RepackReport {
  /** 命中的 setup CRC32（十六进制） */
  crcByIndex: Record<number, string>;
  /** 每条替换样本选中的 VBR quality */
  qualityByIndex: Record<number, number>;
  originalSize: number;
  newSize: number;
  /** 每条替换样本的格式转换信息（Vorbis 保真重采样 / PCM16 增量场景） */
  convertedByIndex: Record<number, { fromCh: number; toCh: number; fromRate: number; toRate: number }>;
  /** 被替换样本因内容长度变化而丢弃的原 loop 块（type 3）下标 */
  droppedLoopByIndex: Record<number, boolean>;
  /**
   * 被替换样本的新旧 PCM 帧数（与写入 FSB5 样本头的 frameCount 一致）。
   * 容器（FEV）前缀的事件/时间线元数据里按帧数缓存了每条音频的「结束时刻」，
   * 导出写回容器时需据此同步这些时长标记，否则游戏仍按旧时长截断播放。
   */
  lengthPatchByIndex: Record<number, { oldFrames: number; newFrames: number }>;
  /** 实际使用的重打包模式 */
  mode: number;
}

/** 探测过的 (channels, rate, quality) → crc32，避免重复编码静音探测 */
const probeCache = new Map<string, number>();

const probeSetupCrc = async (channels: number, sampleRate: number, quality: number): Promise<number> => {
  const key = `${channels}:${sampleRate}:${quality}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  const silence: Float32Array[] = [];
  for (let c = 0; c < channels; c++) silence.push(new Float32Array(1024));
  const ogg = await encodeVorbisOgg(silence, sampleRate, quality);
  const pages = parseOggPages(ogg);
  const pkts: Uint8Array[] = [];
  for (const pg of pages) {
    pkts.push(...pg.packets);
    if (pkts.length >= 3) break;
  }
  const crc = pkts.length >= 3 ? crc32(pkts[2]) : 0;
  probeCache.set(key, crc);
  return crc;
};

/** 在 0..1 的 quality 区间内找出让 setup CRC32 命中 knownCrcs 的那一档 */
const findCompatibleQuality = async (
  channels: number,
  sampleRate: number,
  knownCrcs: Set<number>,
): Promise<{ quality: number; crc: number } | null> => {
  // 原 bank 实测是 0.15，先试低质量档（顺带体积小），再往上扫
  const ladder: number[] = [0.15, 0.1, 0.05, 0.0];
  for (let q = 0.2; q <= 1.0001; q += 0.05) ladder.push(Math.round(q * 100) / 100);
  for (const q of ladder) {
    const crc = await probeSetupCrc(channels, sampleRate, q);
    if (knownCrcs.has(crc)) return { quality: q, crc };
  }
  return null;
};

/**
 * 增量重打包：未替换样本字节级原样保留，仅替换样本用 libvorbis 重新编码。
 * 仅适用于 mode == FSB5_MODE_VORBIS 的 bank；其它编码请走 writeFsb5(PCM16) 路线。
 *
 * @param fsbBytes     原始 FSB5 字节（已从容器里切出来）
 * @param replacements 下标 → 替换用的交错 PCM16
 * @returns 新的 FSB5 字节 + 重打包报告
 */
export const repackFsb5Incremental = async (
  fsbBytes: Uint8Array,
  replacements: Map<number, FsbReplacementPcm>,
): Promise<{ fsb: Uint8Array; report: RepackReport }> => {
  const bank = parseFsb5Raw(fsbBytes);
  // 无任何替换：原样返回原 FSB5 字节。不走重建（重建会重算样本头区/名字表对齐，
  // 产生几字节到几十字节的布局抖动；原样返回则导出与源文件完全一致，零风险）。
  if (replacements.size === 0) {
    return {
      fsb: fsbBytes,
      report: {
        crcByIndex: {},
        qualityByIndex: {},
        originalSize: fsbBytes.length,
        newSize: fsbBytes.length,
        convertedByIndex: {},
        droppedLoopByIndex: {},
        lengthPatchByIndex: {},
        mode: bank.mode,
      },
    };
  }
  // PCM16 bank 走无损增量路线（未替换样本字节原样保留）
  if (bank.mode === FSB5_MODE_PCM16) {
    return repackPcm16Incremental(fsbBytes, bank, replacements);
  }
  if (bank.mode !== FSB5_MODE_VORBIS) {
    throw new Error(
      `repackFsb5Incremental: 不支持的 bank mode=${bank.mode}（仅支持 Vorbis(15) 与 PCM16(2)）`,
    );
  }

  // 原 bank 里出现过的 CRC 一定在 FMOD 内置 codebook 表中（否则原 bank 自己就播不出来）
  const knownCrcs = new Set<number>();
  for (const s of bank.samples) if (s.vorbisCrc != null) knownCrcs.add(s.vorbisCrc);
  if (knownCrcs.size === 0) throw new Error('repackFsb5Incremental: 原 bank 未找到任何 Vorbis setup CRC');

  const crcByIndex: Record<number, string> = {};
  const qualityByIndex: Record<number, number> = {};
  const convertedByIndex: Record<number, { fromCh: number; toCh: number; fromRate: number; toRate: number }> = {};
  const droppedLoopByIndex: Record<number, boolean> = {};
  const lengthPatchByIndex: Record<number, { oldFrames: number; newFrames: number }> = {};
  const list: RebuildSample[] = [];

  for (const s of bank.samples) {
    const rep = replacements.get(s.index);
    if (!rep) {
      list.push({
        name: s.name,
        freqIdx: s.freqIdx,
        chBits: s.chBits,
        frameCount: s.frameCount,
        extraRaw: s.extraRaw,
        dataRaw: s.dataRaw,
      });
      continue;
    }

    let chans = interleavedPcm16ToChannels(rep.pcm, rep.channels);
    let channels = chans.length;
    const sampleRate = rep.sampleRate;

    // 挑 quality 让 setup CRC 命中原 bank 已用值。若当前声道数怎么扫都不命中，
    // 就按原 bank 里存在的声道形态做一次升/降混再试（宁可改声道，也不能写出播不了的 codebook）。
    let hit = await findCompatibleQuality(channels, sampleRate, knownCrcs);
    if (!hit && channels === 2) {
      chans = downmixToMono(chans);
      channels = 1;
      hit = await findCompatibleQuality(channels, sampleRate, knownCrcs);
    } else if (!hit && channels === 1) {
      chans = upmixToStereo(chans);
      channels = 2;
      hit = await findCompatibleQuality(channels, sampleRate, knownCrcs);
    }
    if (!hit) {
      throw new Error(
        `样本 #${s.index} 找不到能命中 FMOD codebook 的编码参数（${rep.channels}ch/${sampleRate}Hz）`,
      );
    }

    const ogg = await encodeVorbisOgg(chans, sampleRate, hit.quality);
    const enc = oggToFsbVorbisSample(ogg);
    if (enc.setupCrc !== hit.crc) {
      throw new Error(`样本 #${s.index} 实际 setup CRC(${hex8(enc.setupCrc)}) 与探测值(${hex8(hit.crc)}) 不符`);
    }

    // extra chunk：新的 type-11 必填；原样本的 peak(13) 若存在则沿用。
    // ⚠️ loop(3) 不沿用：替换内容长度不同，原 loop 点已失效（否则循环样本会卡顿/跳变）。
    const chunkBodies: { type: number; body: Uint8Array }[] = [{ type: 11, body: enc.body11 }];
    const loop = s.chunks.find((c) => c.type === 3);
    const peak = s.chunks.find((c) => c.type === 13);
    if (loop) droppedLoopByIndex[s.index] = true;
    if (peak) chunkBodies.push({ type: 13, body: peak.data });

    let freqIdx = FSB5_FREQ_TABLE.indexOf(sampleRate);
    if (freqIdx < 0) {
      // 采样率不在 FMOD 枚举表里 → 用 index 0 + 显式 frequency chunk
      freqIdx = 0;
      chunkBodies.push({ type: 2, body: u32le(sampleRate) });
    }
    if (channels > 2) chunkBodies.push({ type: 1, body: new Uint8Array([channels & 0xff]) });

    const extraRaw = concat(
      chunkBodies.map((c, i) => buildExtraChunk(c.type, c.body, i < chunkBodies.length - 1)),
    );

    crcByIndex[s.index] = hex8(enc.setupCrc);
    qualityByIndex[s.index] = hit.quality;
    if (channels !== s.channels || sampleRate !== s.sampleRate) {
      convertedByIndex[s.index] = { fromCh: s.channels, toCh: channels, fromRate: s.sampleRate, toRate: sampleRate };
    }
    lengthPatchByIndex[s.index] = { oldFrames: s.frameCount, newFrames: enc.totalFrames };
    list.push({
      name: s.name,
      freqIdx,
      chBits: Math.min(channels, 2) - 1,
      frameCount: enc.totalFrames,
      extraRaw,
      dataRaw: enc.data,
    });
  }

  const fsb = rebuildFsb5(bank, list);
  return {
    fsb,
    report: {
      crcByIndex,
      qualityByIndex,
      originalSize: fsbBytes.length,
      newSize: fsb.length,
      convertedByIndex,
      droppedLoopByIndex,
      lengthPatchByIndex,
      mode: FSB5_MODE_VORBIS,
    },
  };
};

/**
 * PCM16 增量重打包（F 功能）：未替换样本字节级原样保留，仅替换样本用其 PCM16 重写。
 * 优势：未改样本零损失、零重编码（绕开 FMOD 解码→PCM16 往返），且体积小、速度快。
 * 替换样本若格式（声道/采样率）与原样本不同会记录在 convertedByIndex；
 * 原 loop(type 3) 块因内容长度变化而失效，统一丢弃并记录到 droppedLoopByIndex。
 */
const repackPcm16Incremental = (
  fsbBytes: Uint8Array,
  bank: FsbRawBank,
  replacements: Map<number, FsbReplacementPcm>,
): { fsb: Uint8Array; report: RepackReport } => {
  const convertedByIndex: Record<number, { fromCh: number; toCh: number; fromRate: number; toRate: number }> = {};
  const droppedLoopByIndex: Record<number, boolean> = {};
  const lengthPatchByIndex: Record<number, { oldFrames: number; newFrames: number }> = {};
  const list: RebuildSample[] = [];

  for (const s of bank.samples) {
    const rep = replacements.get(s.index);
    if (!rep) {
      list.push({
        name: s.name,
        freqIdx: s.freqIdx,
        chBits: s.chBits,
        frameCount: s.frameCount,
        extraRaw: s.extraRaw,
        dataRaw: s.dataRaw,
      });
      continue;
    }

    const channels = rep.channels;
    const sampleRate = rep.sampleRate;
    const frameCount = Math.floor(rep.pcm.length / channels);
    if (frameCount <= 0) throw new Error(`样本 #${s.index} 替换 PCM 为空`);

    // 保留原 extra 块，但丢弃 type-3 loop（替换内容长度不同，原 loop 点无效）
    const chunkBodies: { type: number; body: Uint8Array }[] = [];
    let hasLoop = false;
    for (const c of s.chunks) {
      if (c.type === 3) {
        hasLoop = true;
        continue;
      }
      chunkBodies.push({ type: c.type, body: c.data });
    }
    if (hasLoop) droppedLoopByIndex[s.index] = true;

    let freqIdx = FSB5_FREQ_TABLE.indexOf(sampleRate);
    if (freqIdx < 0) {
      freqIdx = 0;
      chunkBodies.push({ type: 2, body: u32le(sampleRate) });
    }
    if (channels > 2) chunkBodies.push({ type: 1, body: new Uint8Array([channels & 0xff]) });

    const extraRaw = chunkBodies.length
      ? concat(chunkBodies.map((c, i) => buildExtraChunk(c.type, c.body, i < chunkBodies.length - 1)))
      : new Uint8Array(0);
    const dataRaw = new Uint8Array(rep.pcm.buffer, rep.pcm.byteOffset, rep.pcm.byteLength);

    if (channels !== s.channels || sampleRate !== s.sampleRate) {
      convertedByIndex[s.index] = { fromCh: s.channels, toCh: channels, fromRate: s.sampleRate, toRate: sampleRate };
    }

    lengthPatchByIndex[s.index] = { oldFrames: s.frameCount, newFrames: frameCount };
    list.push({
      name: s.name,
      freqIdx,
      chBits: Math.min(channels, 2) - 1,
      frameCount,
      extraRaw,
      dataRaw,
    });
  }

  const fsb = rebuildFsb5(bank, list);
  return {
    fsb,
    report: {
      crcByIndex: {},
      qualityByIndex: {},
      originalSize: fsbBytes.length,
      newSize: fsb.length,
      convertedByIndex,
      droppedLoopByIndex,
      lengthPatchByIndex,
      mode: FSB5_MODE_PCM16,
    },
  };
};

/**
 * 导出后自检（G 功能）：用高层解析器重新解析生成的 FSB5，
 * 确认是合法 FSB5 且样本数与原始一致。
 */
export const selfCheckRepacked = (
  fsbBytes: Uint8Array,
  originalSampleCount: number,
  knownOffset?: number | null,
): { ok: boolean; sampleCount: number; messages: string[] } => {
  try {
    const parsed = parseFsbBank(fsbBytes, knownOffset);
    if (!parsed) return { ok: false, sampleCount: 0, messages: ['重解析失败：生成的不是合法 FSB5'] };
    const count = parsed.samples.length;
    const ok = count === originalSampleCount;
    return {
      ok,
      sampleCount: count,
      messages: [
        `样本数：${count}${ok ? '（与原始一致）' : `（原始为 ${originalSampleCount}，不一致！）`}`,
      ],
    };
  } catch (e) {
    return { ok: false, sampleCount: 0, messages: [`重解析异常：${(e as Error).message}`] };
  }
};