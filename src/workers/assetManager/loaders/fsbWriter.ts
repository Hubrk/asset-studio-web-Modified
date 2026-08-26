/**
 * FSB5 写入器（重打包核心）。
 *
 * 路线：PCM16（FMOD_SOUND_FORMAT_PCM16 = mode 2）。
 * 理由：Vorbis 在 FSB5 中是「去头」格式，靠 crc32 反查 FMOD 内置 codebook，浏览器端无法可靠重编码；
 * PCM16 是零依赖、FMOD 必然能播的稳妥路线（体积比 Vorbis 大 5–10 倍，换来 100% 兼容）。
 * 规格严格遵循本地研究素材 `oggvorbis2fsb5.c`（uyjulian/oggvorbis2fsb5，MIT）。
 *
 * 文件布局（与解析端 parseFsbBank 完全对称）：
 *   [60 字节头]
 *   [样本头区：每样本 8 字节 bitfield + 按需 extra chunk，整体 16 字节对齐]
 *   [名字表：count×4 的 uint32 偏移数组 + 以 null 结尾的字符串]
 *   [数据区：每样本直接是 [PCM 字节]，整体 32 字节对齐——FSB5 无每样本长度前缀，
 *    长度由样本头 frameCount 决定，相邻样本靠 offset 表界定边界]
 *
 * 容器写回：.bank 是 RIFF 容器（FMOD Designer FEV），内嵌 FSB5 位于某个偏移，其后无其它数据。
 * 注意 SND 数据区与 FSB5 之间存在长度不定的 gap（实测 2/4/22/30 字节），写回时保留前缀原样。
 * wrapFsbInContainer 保留 RIFF 前缀、把新 FSB5 接在偏移处，并：
 *   1. patch SND chunk size（= gap + 新 FSB 体积，向前搜索定位 'SND ' 并以原文件自洽性验证）+ 外层 RIFF size；
 *   2. patch 前缀 SNDH 块里缓存的旧 FSB 体积（体积变化才需）；
 *   3. 同步前缀事件/时间线元数据里按帧数缓存的音频「结束时刻」（否则游戏按旧时长截断播放）。
 */

const FSB5_MAGIC = 0x35425346; // 'FSB5'

/**
 * FSB5 采样率枚举 → 实际 Hz。
 * 这是 FMOD 在 FSB5 样本头里用的那张权威频率表（fmod_codec_fsb5 的 freq_table），
 * 4-bit frequency 字段存的是「本表的下标」，不是原始 Hz。播放器据此还原采样率，
 * 所以本表必须与 FMOD 逐位对齐，否则会被读成错误采样率 → 升/降速 → 嘶嘶嘶噪声。
 */
export const FSB5_FREQ_TABLE = [
  0, 8000, 11000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 96000, 0, 0, 0, 0, 0,
];

/** FMOD_SOUND_FORMAT 枚举值；PCM16 = 2，Vorbis = 15（FSB5 头 mode 字段即此值）。 */
export const FSB5_MODE_PCM16 = 2;
export const FSB5_MODE_VORBIS = 15;

export interface FsbWriteSample {
  /** 样本名（写进 name table，UTF-8） */
  name: string;
  /** 交错 PCM16（int16 LE），长度必须 = frames * channels */
  pcm: Int16Array;
  channels: number;
  sampleRate: number;
  /** 循环起点（PCM 帧），提供则写 type 3 循环 chunk */
  loopStart?: number;
  /** 循环终点（PCM 帧，含），提供则写 type 3 循环 chunk */
  loopEnd?: number;
}

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

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

/** 构造一个 extra chunk 头 + 数据体；hasNext 串接后续 chunk。 */
const buildExtraChunk = (chunkType: number, body: Uint8Array, hasNext: boolean): Uint8Array => {
  const hdr = new Uint8Array(4);
  const hdv = new DataView(hdr.buffer);
  let v = 0;
  v |= (body.length & 0xffffff) << 1; // size: 24 bit
  if (hasNext) v |= 1; // has_next: 1 bit
  v |= chunkType << 25; // chunk_type: 7 bit
  hdv.setUint32(0, v >>> 0, true);
  return concat([hdr, body]);
};

/**
 * 把若干样本构建为合法 FSB5 字节（PCM16）。
 * @param samples 样本列表（顺序即 bank 内子音频下标）
 * @param mode    FSB5 头 mode 字段，默认 PCM16
 */
export const writeFsb5 = (samples: FsbWriteSample[], mode: number = FSB5_MODE_PCM16): Uint8Array => {
  const numSamples = samples.length;

  const sampleHeaderParts: Uint8Array[] = [];
  const dataParts: Uint8Array[] = [];
  const names: string[] = [];

  let dataCursor = 0; // 数据区内当前字节偏移（相对数据区起点），32 字节对齐累加

  samples.forEach((s) => {
    const pcmU8 = new Uint8Array(s.pcm.buffer, s.pcm.byteOffset, s.pcm.byteLength);
    const frameCount = Math.floor(s.pcm.length / s.channels);
    const freqIdx = FSB5_FREQ_TABLE.indexOf(s.sampleRate);
    const freqIdxClamped = freqIdx >= 0 ? freqIdx : 0;
    // channels 是 2 bit：0=单声道 1=立体声；>2 声道靠 extra chunk type 1 精确给出
    const chBits = Math.min(Math.max(s.channels, 1), 2) - 1;

    // 决定需要哪些 extra chunk
    const extras: { type: number; body: Uint8Array }[] = [];
    if (s.channels !== 1 && s.channels !== 2) {
      extras.push({ type: 1, body: new Uint8Array([s.channels & 0xff]) }); // channels
    }
    // 仅当采样率不在 FMOD 标准表里（freqIdx<0）才写 frequency extra chunk；
    // 表中已有的（含 index 0 = 4000）只靠 4-bit 下标即可，FMOD 不再额外看 chunk。
    if (freqIdx < 0) {
      extras.push({ type: 2, body: u32le(s.sampleRate) }); // frequency（枚举命中不了）
    }
    if (s.loopStart != null && s.loopEnd != null) {
      extras.push({ type: 3, body: concat([u32le(s.loopStart), u32le(s.loopEnd)]) }); // loop
    }
    const hasExtra = extras.length > 0;

    // 组装 8 字节 bitfield（LSB 起）
    // extra_param:1 | frequency:4 | channels:2 | dataOffset:27 | samples:30
    //
    // ⚠️ 历史 bug：这里曾写成 `stereo:1 | dataOffset:28 @ bit6`。由于解析端当时用同一套错误位宽，
    // 自检能过，但 FMOD 按正确位宽读会把 dataOffset 读成实际值的一半 → 跳到别的样本中间去解码，
    // 表现为「改了一条样本，别的音频全变成奇怪的噪声/倍速」。真实 98 样本 bank 已实证：
    // dataOffset 起始于 bit7 且为 27 位，channels 占 bit5..6。
    let field = 0n;
    if (hasExtra) field |= 1n;
    field |= BigInt(freqIdxClamped & 0xf) << 1n;
    field |= BigInt(chBits & 0x3) << 5n;
    field |= BigInt((dataCursor / 32) & 0x07ffffff) << 7n; // 真实字节偏移 = dataOffset * 32
    field |= BigInt(frameCount & 0x3fffffff) << 34n;
    const sh = new Uint8Array(8);
    new DataView(sh.buffer).setBigUint64(0, field, true);

    const shParts: Uint8Array[] = [sh];
    extras.forEach((e, i) => {
      const isLast = i === extras.length - 1;
      shParts.push(buildExtraChunk(e.type, e.body, !isLast));
    });
    sampleHeaderParts.push(concat(shParts));

    // 数据区：直接是 [PCM 字节]（FSB5 无每样本长度前缀，长度由样本头 frameCount 决定），
    // 整块按 32 字节对齐补 0。dataCursor 已是 32 对齐累加，故每块补到 32 对齐即可。
    const segLen = pcmU8.length;
    const alignedLen = Math.ceil(segLen / 32) * 32;
    const padded = new Uint8Array(alignedLen);
    padded.set(pcmU8, 0);
    dataParts.push(padded);

    dataCursor += alignedLen;
    names.push(s.name);
  });

  const sampleHeaderRegion = concat(sampleHeaderParts);
  // 样本头区（含头）按 16 字节对齐补 0
  const shPad = (16 - ((60 + sampleHeaderRegion.length) % 16)) % 16;

  // 名字表：uint32 偏移数组 + 字符串（含 null 结尾）
  const encoder = new TextEncoder();
  const nameBodies: Uint8Array[] = names.map((n) => {
    const b = encoder.encode(n);
    const arr = new Uint8Array(b.length + 1);
    arr.set(b);
    return arr;
  });
  const offsetBuf = new Uint8Array(names.length * 4);
  const odv = new DataView(offsetBuf.buffer);
  // 偏移相对名字表起点（含本偏移数组）；首个字符串位于偏移 count*4 处。
  // 真实样本验证：98 样本的首偏移恰为 98*4=392，字符串紧随偏移数组之后。
  let cur = names.length * 4;
  nameBodies.forEach((body, i) => {
    odv.setUint32(i * 4, cur, true);
    cur += body.length;
  });
  const nameTable = concat([offsetBuf, ...nameBodies]);

  const sampleHeaderSize = sampleHeaderRegion.length + shPad;
  const nameTableSize = nameTable.length;
  const dataSize = dataCursor;

  // 60 字节头
  const header = new Uint8Array(60);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(0, FSB5_MAGIC, true);
  hdv.setUint32(4, 1, true); // version
  hdv.setUint32(8, numSamples, true);
  hdv.setUint32(12, sampleHeaderSize, true);
  hdv.setUint32(16, nameTableSize, true);
  hdv.setUint32(20, dataSize, true);
  hdv.setUint32(24, mode >>> 0, true);
  header[28] = 1; // zero[0] = 1（FMOD 不校验其余字段）

  return concat([header, sampleHeaderRegion, new Uint8Array(shPad), nameTable, ...dataParts]);
};

/**
 * 从 FSB5 字节中提取第 index 个子音频的交错 PCM16（用于自检/校验，不依赖 FMOD）。
 * 仅在 bank 为 PCM16（mode=2）时有意义；其它编码返回 null。
 */
export const extractFsbSamplePcm = (
  fsb: Uint8Array,
  index: number,
): { pcm: Int16Array; channels: number; sampleRate: number } | null => {
  if (fsb.length < 60) return null;
  const dv = new DataView(fsb.buffer, fsb.byteOffset, fsb.byteLength);
  if (dv.getUint32(0, true) !== FSB5_MAGIC) return null;
  const mode = dv.getUint32(24, true);
  if (mode !== FSB5_MODE_PCM16) return null;
  const numSamples = dv.getUint32(8, true);
  const sampleHeaderSize = dv.getUint32(12, true);
  const nameTableSize = dv.getUint32(16, true);
  const dataSize = dv.getUint32(20, true);
  if (index < 0 || index >= numSamples) return null;

  // 遍历样本头找目标（与 parseFsbBank 同逻辑）
  let off = 60;
  const sampleHeaderEnd = 60 + sampleHeaderSize;
  let target: { dataOffset: number; frameCount: number; channels: number; sampleRate: number } | null = null;
  for (let i = 0; i < numSamples; i++) {
    const sh = dv.getBigUint64(off, true);
    off += 8;
    const extraParam = Number(sh & 1n);
    const freqIdx = Number((sh >> 1n) & 0xfn);
    const chBits = Number((sh >> 5n) & 0x3n);
    const dataOffset = Number((sh >> 7n) & 0x07ffffffn) * 32;
    const frameCount = Number((sh >> 34n) & 0x3fffffffn);
    let channels = chBits + 1;
    let sampleRate = FSB5_FREQ_TABLE[freqIdx] ?? 0;
    if (extraParam) {
      let guard = 0;
      while (guard++ < 64) {
        if (off + 4 > sampleHeaderEnd) break;
        const eh = dv.getUint32(off, true);
        off += 4;
        const size = (eh >> 1) & 0xffffff;
        const chunkType = (eh >> 25) & 0x7f;
        if (chunkType === 1) channels = dv.getUint8(off);
        else if (chunkType === 2) sampleRate = dv.getUint32(off, true);
        off += size;
        if (!(eh & 1)) break;
      }
    }
    if (i === index) {
      target = { dataOffset, frameCount, channels, sampleRate };
      break;
    }
  }
  if (!target) return null;

  const dataRegionStart = 60 + sampleHeaderSize + nameTableSize;
  const segStart = dataRegionStart + target.dataOffset;
  // FSB5 数据段无每样本长度前缀，PCM16 每样本 2 字节，长度由样本头 frameCount 决定：
  const pcmLen = target.frameCount * target.channels * 2;
  const pcmStart = segStart;
  if (pcmStart + pcmLen > fsb.length) return null;
  const pcm = new Int16Array(pcmLen / 2);
  // 用 DataView 逐样本拷贝，避免 Int16Array(buffer, byteOffset) 对内存对齐的要求
  // （fsb 可能是带奇数偏移的 subarray，直接建 Int16Array 视图会抛 RangeError）。
  const src = new DataView(fsb.buffer, fsb.byteOffset + pcmStart, pcmLen);
  for (let i = 0; i < pcm.length; i++) pcm[i] = src.getInt16(i * 2, true);
  void dataSize;
  return { pcm, channels: target.channels, sampleRate: target.sampleRate };
};

/**
 * 把 FMOD 解码出的 WAV 字节转为交错 Int16 PCM。
 *
 * ⚠️ 关键修复：FMOD 对不同编码吐出的 WAV 位深不同——
 *   压缩格式(Vorbis/FADPCM)强制 16-bit，但 PCMFLOAT 样本是 IEEE float 32-bit，
 *   还有 PCM24/PCM32 等情况。旧实现无条件按 16-bit 用 getInt16 读，
 *   遇到 float/24/32-bit WAV 会把浮点/多字节样本当 16-bit 解读 → 整段纯噪声(嘶嘶嘶)。
 *
 * 这里正确 Walk WAV chunk 解析 fmt，并按实际位深/格式转换：
 *   PCM 8/16/24/32 → 对齐到 int16；float 32/64 → clamp(-1..1)*32767。
 */
export const wavToPcm16 = (wav: Uint8Array): { pcm: Int16Array; channels: number; sampleRate: number } => {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (dv.getUint32(0, true) !== 0x46464952 /* 'RIFF' */ || dv.getUint32(8, true) !== 0x45564157 /* 'WAVE' */) {
    throw new Error('wavToPcm16: 不是合法的 WAV');
  }

  let off = 12;
  let audioFormat = 1; // 1=PCM, 3=IEEE float, 0xFFFE=WAVEFORMATEXTENSIBLE
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 16;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= wav.length) {
    const id = dv.getUint32(off, true);
    const size = dv.getUint32(off + 4, true);
    if (id === 0x20746d66 /* 'fmt ' */) {
      audioFormat = dv.getUint16(off + 8, true);
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bitsPerSample = dv.getUint16(off + 22, true);
    } else if (id === 0x61746164 /* 'data' */) {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    if (size <= 0) break;
    off += 8 + size + (size & 1); // 块按偶对齐
  }
  if (dataOff < 0) throw new Error('wavToPcm16: WAV 缺少 data 块');

  const src = new DataView(wav.buffer, wav.byteOffset + dataOff, dataLen);
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor((dataLen * 8) / bitsPerSample);
  const pcm = new Int16Array(totalSamples);

  // WAVEFORMATEXTENSIBLE(0xFFFE)：32-bit 视为 float，其余按整数
  const isFloat = audioFormat === 3 || (audioFormat === 0xfffe && bitsPerSample === 32);
  for (let i = 0; i < totalSamples; i++) {
    const b = i * bytesPerSample;
    let v = 0;
    if (isFloat) {
      const f = bitsPerSample === 64 ? src.getFloat64(b, true) : src.getFloat32(b, true);
      v = Math.max(-1, Math.min(1, f)) * 32767;
    } else if (bitsPerSample === 16) {
      v = src.getInt16(b, true);
    } else if (bitsPerSample === 8) {
      v = (src.getUint8(b) - 128) << 8;
    } else if (bitsPerSample === 24) {
      const u = (src.getUint8(b) | (src.getUint8(b + 1) << 8) | (src.getUint8(b + 2) << 16)) >>> 0;
      const s24 = u & 0x800000 ? u - 0x1000000 : u; // 24-bit 符号还原
      v = s24 >> 8; // 24→16 带符号（截断低 8 位）
    } else if (bitsPerSample === 32) {
      v = src.getInt32(b, true) >> 16; // 32→16 带符号
    }
    pcm[i] = v | 0;
  }

  return { pcm, channels, sampleRate };
};

/**
 * 在 [start, end) 范围内把所有等于 oldVal 的 u32 覆写为 newVal，返回命中次数。
 * 用于容器前缀的时长/体积字段 patch：这些字段值都是大整数（帧数/字节数），
 * 按值匹配误命中概率可忽略（实测 34KB 前缀内仅存在于已知的标记位置）。
 */
const replaceU32InRange = (dv: DataView, start: number, end: number, oldVal: number, newVal: number): number => {
  let count = 0;
  const target = oldVal >>> 0;
  const next = newVal >>> 0;
  for (let p = start; p + 4 <= end; p++) {
    if (dv.getUint32(p, true) === target) {
      dv.setUint32(p, next, true);
      count++;
      p += 3; // 跳过刚写的 4 字节，避免重叠匹配（循环步进再 +1）
    }
  }
  return count;
};

/**
 * 从 fsbOffset 向前定位 'SND ' chunk 头，返回 { tagOff, gap }；找不到返回 null。
 *
 * ⚠️ SND 数据区与 FSB5 之间普遍存在 gap（实测各 bank 为 2/4/22/30 字节不等，全零填充），
 * 所以 tag 不在固定的 fsbOffset-8 处。定位后用原文件的自洽性验证：
 *   原 SND size 必须 == 文件总长 - (tagOff + 8)（SND 是末块，覆盖 gap+FSB 直到文件尾），
 * 以此排除误命中其它恰好叫 'SND ' 的字节。
 */
const findSndChunk = (
  containerBytes: Uint8Array,
  fsbOffset: number,
): { tagOff: number; gap: number } | null => {
  const dv = new DataView(containerBytes.buffer, containerBytes.byteOffset, containerBytes.byteLength);
  const lo = Math.max(0, fsbOffset - 1024);
  for (let i = fsbOffset - 8; i >= lo; i--) {
    if (
      containerBytes[i] === 0x53 && // S
      containerBytes[i + 1] === 0x4e && // N
      containerBytes[i + 2] === 0x44 && // D
      containerBytes[i + 3] === 0x20 // ' '
    ) {
      const size = dv.getUint32(i + 4, true);
      if (size === containerBytes.length - (i + 8)) {
        return { tagOff: i, gap: fsbOffset - (i + 8) };
      }
    }
  }
  return null;
};

/** 容器写回结果 */
export interface ContainerWrapResult {
  bytes: Uint8Array;
  /** 前缀内同步的时长标记（帧数）处数 */
  lengthPatched: number;
  /** 前缀内同步的旧 FSB 体积字段处数 */
  sizePatched: number;
}

/**
 * 把新 FSB5 写回 RIFF/任意容器：保留偏移之前的前缀（含 SND→FSB 间的 gap 填充），
 * 接上新 FSB5，并 patch 各 size/时长字段。
 * - SND chunk size = gap + newFsb.length（gap 因 bank 而异，动态定位 + 自洽验证）。
 *   ⚠️ 旧实现把 tag 固定在 fsbOffset-8，gap≠4 的 bank 全部漏 patch → SND size 指向文件尾之外 → 游戏拒读整包 → 静音。
 * - 外层 RIFF 的 4 字节 size 位于文件偏移 4（= 总长 - 8）
 * - opts.oldFsbSize：原 FSB5 字节数，用于同步前缀 SNDH 块里的体积缓存（体积变化才需）
 * - opts.lengthPairs：被替换样本的新旧帧数，用于同步前缀里的音频时长标记（替换音频变长/变短时必需，
 *   否则游戏仍按旧时长截断播放）
 * FSB5 数据区 32 字节对齐 → 长度必为偶数，无需 RIFF 奇偶补位。
 */
export const wrapFsbInContainer = (
  containerBytes: Uint8Array,
  fsbOffset: number,
  newFsb: Uint8Array,
  opts?: {
    oldFsbSize?: number;
    lengthPairs?: { oldFrames: number; newFrames: number }[];
  },
): ContainerWrapResult => {
  const prefix = containerBytes.subarray(0, fsbOffset);
  const out = concat([prefix, newFsb]);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // SND chunk size：从 fsbOffset 向前定位 'SND '（gap 可变为 0），写入 gap + newFsb 长度
  const snd = findSndChunk(containerBytes, fsbOffset);
  if (snd) {
    dv.setUint32(snd.tagOff + 4, snd.gap + newFsb.length, true);
  }
  // 外层 RIFF size（offset 4）= 总长 - 8
  if (out.length >= 8 && containerBytes[0] === 0x52 /* R */) {
    dv.setUint32(4, out.length - 8, true);
  }
  // 前缀 SNDH 块里的旧 FSB 体积（实测：'SNDH' 数据区 = u16, u16, u32 FSB偏移, u32 FSB体积）
  let sizePatched = 0;
  const oldFsbSize = opts?.oldFsbSize;
  if (oldFsbSize != null && oldFsbSize !== newFsb.length) {
    sizePatched = replaceU32InRange(dv, 0, fsbOffset, oldFsbSize, newFsb.length);
  }
  // 前缀事件/时间线元数据里的音频时长标记（按帧数存）：逐对替换旧帧数 → 新帧数。
  // 只扫前缀 [0, fsbOffset)，绝不碰 FSB5 数据本身。
  let lengthPatched = 0;
  for (const pair of opts?.lengthPairs ?? []) {
    if (pair.oldFrames === pair.newFrames) continue;
    lengthPatched += replaceU32InRange(dv, 0, fsbOffset, pair.oldFrames, pair.newFrames);
  }
  return { bytes: out, lengthPatched, sizePatched };
};