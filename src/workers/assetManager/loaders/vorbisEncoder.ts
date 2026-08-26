/**
 * libvorbis（Xiph 官方参考实现，emscripten asm.js 编译）薄封装。
 *
 * 为什么必须是「真·libvorbis」而不是任意 Vorbis 编码器：
 * FSB5 里的 Vorbis 是「去头」格式——数据区只存裸音频包，identification/comment/setup 三个头包被剥离，
 * 播放时 FMOD 依据样本 extra chunk(type 11) 里的 setup 包 CRC32 去反查它内置的 codebook 表来重建解码器。
 * 只有字节级复现 Xiph 参考实现的 setup 包，CRC32 才能命中 FMOD 内置表，音频才放得出来。
 *
 * 该模块 2.1MB，故采用动态 import 让 Vite 单独切 chunk，只有真正重打包 bank 时才下载。
 */

/** libvorbis emscripten 模块暴露出的编码 API 子集 */
export interface LibVorbisModule {
  _encoder_init(channels: number, sampleRate: number, quality: number): number;
  _encoder_stream_init(enc: number): void;
  /** 返回 float** 指针（字节地址），每声道一个 float* */
  _encoder_analysis_buffer(enc: number, frames: number): number;
  _encoder_process(enc: number, frames: number): void;
  _encoder_data_len(enc: number): number;
  /** 返回已产出 Ogg 字节的起始指针，长度见 _encoder_data_len */
  _encoder_transfer_data(enc: number): number;
  _encoder_clear(enc: number): void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
}

let modulePromise: Promise<LibVorbisModule> | null = null;

/** 惰性加载 libvorbis（进程内只加载一次） */
export const loadLibVorbis = async (): Promise<LibVorbisModule> => {
  if (!modulePromise) {
    modulePromise = (async () => {
      const g = globalThis as unknown as Record<string, unknown>;
      // emscripten 老版 asm.js 靠 `typeof importScripts === 'function'` 判定 Worker 环境。
      // Vite 打出的 ES module worker 没有 importScripts，会掉进 SHELL 分支引用未定义的 print/read 而崩。
      // 补一个占位实现即可让它走 WEB/WORKER 分支——该分支里 XHR / document 的引用全在函数体内，
      // 加载期不会执行，而本模块是单文件 asm.js（无 .mem/.wasm 旁挂文件），根本不会去 fetch。
      // Node 下 emscripten 会自己走 NODE 分支（require/process 都在），此时绝不能补 importScripts，
      // 否则会被误判成 WORKER 而去引用不存在的 self。仅在「既不是浏览器也不是 Node」时才补。
      const isNode =
        typeof (g.process as { versions?: { node?: string } } | undefined)?.versions?.node ===
        'string';
      if (!isNode && typeof g.importScripts !== 'function' && typeof g.window !== 'object') {
        g.importScripts = () => {
          throw new Error('importScripts 在此环境不可用');
        };
      }
      const mod = (await import('vorbis-encoder-js/dist/libvorbis.js')) as unknown as {
        default?: LibVorbisModule;
      } & LibVorbisModule;
      const resolved = (mod.default ?? mod) as LibVorbisModule;
      if (typeof resolved._encoder_init !== 'function') {
        throw new Error('libvorbis 加载失败：未找到 _encoder_init');
      }
      return resolved;
    })();
  }
  return modulePromise;
};

const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
};

/**
 * 把分声道 Float32 PCM 编码为完整的 Ogg Vorbis 字节流（含三个头包）。
 * @param channelData 每声道一条 Float32Array，长度必须一致，取值 -1..1
 * @param sampleRate  采样率
 * @param quality     VBR 质量 -0.1 ~ 1.0（决定 setup 包，从而决定 CRC32）
 */
export const encodeVorbisOgg = async (
  channelData: Float32Array[],
  sampleRate: number,
  quality: number,
): Promise<Uint8Array> => {
  const lib = await loadLibVorbis();
  const channels = channelData.length;
  if (channels < 1) throw new Error('encodeVorbisOgg: 声道数为 0');
  const totalFrames = channelData[0].length;

  const enc = lib._encoder_init(channels, sampleRate, quality);
  lib._encoder_stream_init(enc);
  const out: Uint8Array[] = [];

  const pump = (frames: number) => {
    lib._encoder_process(enc, frames);
    const n = lib._encoder_data_len(enc);
    if (n > 0) {
      const ptr = lib._encoder_transfer_data(enc);
      // 必须立刻拷出：下一次 process 可能触发堆增长，旧的 HEAPU8 视图会失效
      out.push(new Uint8Array(lib.HEAPU8.subarray(ptr, ptr + n)));
    }
  };

  const BLOCK = 4096;
  for (let i = 0; i < totalFrames; i += BLOCK) {
    const blk = Math.min(BLOCK, totalFrames - i);
    const bufPtrs = lib._encoder_analysis_buffer(enc, blk) >> 2; // float** → HEAPU32 下标
    for (let ch = 0; ch < channels; ch++) {
      lib.HEAPF32.set(channelData[ch].subarray(i, i + blk), lib.HEAPU32[bufPtrs + ch] >> 2);
    }
    pump(blk);
  }
  pump(0); // frames=0 → 收尾，冲出末页
  lib._encoder_clear(enc);

  return concatBytes(out);
};

/** 交错 Int16 PCM → 分声道 Float32（-1..1） */
export const interleavedPcm16ToChannels = (pcm: Int16Array, channels: number): Float32Array[] => {
  const frames = Math.floor(pcm.length / channels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chans.push(new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    const base = f * channels;
    for (let c = 0; c < channels; c++) chans[c][f] = pcm[base + c] / 32768;
  }
  return chans;
};

/** 立体声（或多声道）降混为单声道 */
export const downmixToMono = (chans: Float32Array[]): Float32Array[] => {
  if (chans.length <= 1) return chans;
  const n = chans[0].length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of chans) s += c[i];
    mono[i] = s / chans.length;
  }
  return [mono];
};

/** 单声道升为立体声（复制） */
export const upmixToStereo = (chans: Float32Array[]): Float32Array[] => {
  if (chans.length >= 2) return chans;
  return [chans[0], new Float32Array(chans[0])];
};
