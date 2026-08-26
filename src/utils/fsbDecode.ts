import FMOD from '@arkntools/fmod';
import { once } from 'es-toolkit';

/**
 * 主线程 FSB5 子音频解码器。
 *
 * 复用 @arkntools/fmod 的 WASM（与 @arkntools/unity-js 的 convertFsb 同一套 FMOD），
 * 把独立 bank 里「指定的第 index 个子音频」解码为 WAV 字节。
 *
 * 为什么放在主线程：本项目的 AudioClipLoader.fsbConverter 本身就是一个「主线程函数」，
 * 经 Comlink 回传给 worker 调用（FMOD WASM 需要 window，worker 里没有）。
 * 这里的解码函数同样由主线程提供、经 Comlink 在 worker 触发时回主线程执行。
 *
 * 支持所有 FMOD 能解的编码（PCM / Vorbis / FADPCM / AT9 ...）：
 * lock 出来的是已解码的 PCM；对于压缩格式，WAV 头统一按 16-bit 写出。
 */

const SYMBOL = {
  OUTVAR: Symbol('outvar'),
  OUTVAR_DISMISS: Symbol('outvar_dismiss'),
};

// 把 FMOD 的 $ 前缀方法包成「自动抽取 outvar」的代理（与 @arkntools/unity-js 实现一致）
const createWrapper = (Module: any) =>
  new Proxy(Module, {
    get(target, p) {
      if (p in target || typeof p !== 'string' || !p.startsWith('$')) {
        return target[p];
      }
      p = p.substring(1);
      if (typeof target[p] !== 'function') return target[p];
      return (...args: any[]) => {
        const outvars: Array<{ val?: any }> = [];
        const useArgs = args.map(arg => {
          if (arg === SYMBOL.OUTVAR) {
            const outvar = {};
            outvars.push(outvar);
            return outvar;
          }
          if (arg === SYMBOL.OUTVAR_DISMISS) return {};
          return arg;
        });
        const result = target[p](...useArgs);
        if (result !== 0) throw new Error(`[FMOD] ${p} failed, result=${result}`);
        return outvars.length > 1 ? outvars.map(outvar => outvar.val) : outvars[0]?.val;
      };
    },
  });

const initFMOD = once(async () => {
  if (!globalThis.self) (globalThis as any).self = globalThis;
  const Module: any = await FMOD();
  // 主线程原生拥有 window，Emscripten 可直接用；显式挂上以防 glue 访问 Module.window
  Module.window = globalThis;
  return createWrapper(Module);
});

const systemCache = new Map<number, any>();

const initFMODSystem = async (channels: number) => {
  const FMOD = await initFMOD();
  let system = systemCache.get(channels);
  if (!system) {
    system = createWrapper(FMOD.$System_Create(SYMBOL.OUTVAR));
    system.$init(channels, FMOD.INIT_NORMAL, 0);
    systemCache.set(channels, system);
  }
  return { FMOD, system };
};

const numberToBits = (num: number, short = false) => {
  const array = new Uint8Array(short ? 2 : 4);
  new DataView(array.buffer)[short ? 'setUint16' : 'setUint32'](0, num, true);
  return array;
};

/** 把 FMOD sound 的 PCM 锁出并封装成 WAV。压缩格式强制 16-bit（lock 出的就是 PCM16）。 */
const soundToWav = (FMOD: any, sound: any) => {
  const [format, channels, bits] = sound.$getFormat(
    SYMBOL.OUTVAR_DISMISS,
    SYMBOL.OUTVAR,
    SYMBOL.OUTVAR,
    SYMBOL.OUTVAR,
  );
  let sampleRate = Math.floor(sound.$getDefaults(SYMBOL.OUTVAR, SYMBOL.OUTVAR_DISMISS));
  const length = sound.$getLength(SYMBOL.OUTVAR, FMOD.TIMEUNIT_PCMBYTES);
  const [ptr1, ptr2, len1, len2] = sound.$lock(
    0,
    length,
    SYMBOL.OUTVAR,
    SYMBOL.OUTVAR,
    SYMBOL.OUTVAR,
    SYMBOL.OUTVAR,
  );

  try {
    // 健壮性：解码结果非法时给出明确错误，而不是生成坏 WAV / 静音文件
    if (!channels || channels < 1) throw new Error('解码声道数为 0');
    if (!len1 || len1 < 1) throw new Error('解码结果为空（该编码可能不受支持）');
    if (!sampleRate || sampleRate < 1) sampleRate = 44100; // 仅兜底 0/非法值，合法的低采样率（如 8kHz）保持不变

    let wavFormat: number;
    let wavBits: number;
    if (
      [
        FMOD.SOUND_FORMAT_PCM8,
        FMOD.SOUND_FORMAT_PCM16,
        FMOD.SOUND_FORMAT_PCM24,
        FMOD.SOUND_FORMAT_PCM32,
      ].includes(format)
    ) {
      wavFormat = 1;
      wavBits = [8, 16, 24, 32][
        [
          FMOD.SOUND_FORMAT_PCM8,
          FMOD.SOUND_FORMAT_PCM16,
          FMOD.SOUND_FORMAT_PCM24,
          FMOD.SOUND_FORMAT_PCM32,
        ].indexOf(format)
      ];
    } else if (format === FMOD.SOUND_FORMAT_PCMFLOAT) {
      wavFormat = 3;
      wavBits = 32;
    } else {
      // Vorbis / FADPCM / AT9 / MP3 等压缩格式：FMOD lock 返回已解码 PCM，按 16-bit 写出
      wavFormat = 1;
      wavBits = 16;
    }

    const textEncoder = new TextEncoder();
    const buffer = new Uint8Array(len1 + 44);

    buffer.set(textEncoder.encode('RIFF'), 0);
    buffer.set(numberToBits(len1 + 36), 4);
    buffer.set(textEncoder.encode('WAVEfmt '), 8);
    buffer.set(numberToBits(16), 16);
    buffer.set(numberToBits(wavFormat, true), 20);
    buffer.set(numberToBits(channels, true), 22);
    buffer.set(numberToBits(sampleRate), 24);
    buffer.set(numberToBits((sampleRate * channels * wavBits) / 8), 28);
    buffer.set(numberToBits((channels * wavBits) / 8, true), 32);
    buffer.set(numberToBits(wavBits, true), 34);
    buffer.set(textEncoder.encode('data'), 36);
    buffer.set(numberToBits(len1), 40);

    const heap: Uint8Array = FMOD.HEAPU8;
    buffer.set(heap.subarray(ptr1, ptr1 + len1), 44);

    return buffer;
  } finally {
    // 无论成功与否都解锁，避免 FMOD 内存泄漏
    sound.$unlock(ptr1, ptr2, len1, len2);
  }
};

/**
 * 解码独立 FSB bank 中第 index 个子音频为 WAV。
 * @param data   完整 FSB5 字节
 * @param size   FSB 字节长度
 * @param channels 声道数（用于选择 FMOD system 实例，影响混音通道数）
 * @param index  子音频下标（FMOD getSubSound(index)）
 */
export const decodeFsbSubSound = async (
  data: Uint8Array,
  size: number,
  channels: number,
  index: number,
  targetSampleRate?: number,
): Promise<Uint8Array> => {
  const { FMOD, system } = await initFMODSystem(channels || 1);

  const exinfo = FMOD.CREATESOUNDEXINFO();
  exinfo.length = size;
  // 强制以目标采样率解码（重打包时传原始头部采样率）。否则 FMOD 的 getDefaults()
  // 可能返回系统混音率而非样本原生率，导致「头标记速率 ≠ 实际 PCM 速率」→ 倍速播放。
  if (targetSampleRate && targetSampleRate > 0) {
    exinfo.defaultfrequency = targetSampleRate;
  }

  const sound = createWrapper(system.$createSound(data, FMOD.OPENMEMORY, exinfo, SYMBOL.OUTVAR));
  const subSound = createWrapper(sound.$getSubSound(index, SYMBOL.OUTVAR));
  try {
    return soundToWav(FMOD, subSound);
  } finally {
    subSound.release();
    sound.release();
  }
};
