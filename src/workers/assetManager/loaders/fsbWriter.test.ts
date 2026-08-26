import { describe, it, expect } from 'vitest';
import { parseFsbBank } from './fsbBank';
import {
  writeFsb5,
  extractFsbSamplePcm,
  wrapFsbInContainer,
  wavToPcm16,
  type FsbWriteSample,
} from './fsbWriter';

/** 手工构造一个 WAV（44 字节头 + data 块）。audioFormat: 1=PCM, 3=IEEE float。 */
const buildWav = (
  audioFormat: number,
  bits: number,
  channels: number,
  sampleRate: number,
  samples: number[],
): Uint8Array => {
  const bps = bits / 8;
  const dataLen = samples.length * bps;
  const wav = new Uint8Array(44 + dataLen);
  const dv = new DataView(wav.buffer);
  const enc = new TextEncoder();
  wav.set(enc.encode('RIFF'), 0);
  dv.setUint32(4, 36 + dataLen, true);
  wav.set(enc.encode('WAVEfmt '), 8);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, audioFormat, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, (sampleRate * channels * bits) / 8, true);
  dv.setUint16(32, (channels * bits) / 8, true);
  dv.setUint16(34, bits, true);
  wav.set(enc.encode('data'), 36);
  dv.setUint32(40, dataLen, true);
  samples.forEach((s, i) => {
    const b = 44 + i * bps;
    if (bits === 16) dv.setInt16(b, s, true);
    else if (bits === 24) {
      const v = s < 0 ? s + 0x1000000 : s;
      dv.setUint8(b, v & 0xff);
      dv.setUint8(b + 1, (v >> 8) & 0xff);
      dv.setUint8(b + 2, (v >> 16) & 0xff);
    } else if (bits === 8) dv.setUint8(b, s & 0xff);
    else if (bits === 32 && audioFormat === 3) dv.setFloat32(b, s, true);
  });
  return wav;
};

describe('wavToPcm16 格式感知（修复嘶嘶嘶噪声）', () => {
  it('16-bit PCM：原样透传', () => {
    const wav = buildWav(1, 16, 1, 44100, [0, 1234, -5678, 32767, -32768]);
    const { pcm, channels, sampleRate } = wavToPcm16(wav);
    expect(channels).toBe(1);
    expect(sampleRate).toBe(44100);
    expect(Array.from(pcm)).toEqual([0, 1234, -5678, 32767, -32768]);
  });

  it('IEEE float 32-bit：正确量化（不再把 float 字节当 int16 → 噪声）', () => {
    const wav = buildWav(3, 32, 1, 44100, [0, 0.5, -0.5, 1.0, -1.0]);
    const { pcm } = wavToPcm16(wav);
    expect(Array.from(pcm)).toEqual([0, 16383, -16383, 32767, -32767]);
  });

  it('24-bit PCM：符号正确下采样到 16-bit', () => {
    const wav = buildWav(1, 24, 1, 44100, [0, 1000000, -2000000, 8388607]);
    const { pcm } = wavToPcm16(wav);
    expect(Array.from(pcm)).toEqual([0, 3906, -7813, 32767]);
  });

  it('8-bit PCM：无符号偏移居中', () => {
    const wav = buildWav(1, 8, 1, 44100, [128, 255, 0]);
    const { pcm } = wavToPcm16(wav);
    expect(Array.from(pcm)).toEqual([0, 32512, -32768]);
  });

  it('立体声交错：声道数正确传递', () => {
    const wav = buildWav(1, 16, 2, 48000, [100, -100, 200, -200]);
    const { pcm, channels } = wavToPcm16(wav);
    expect(channels).toBe(2);
    expect(Array.from(pcm)).toEqual([100, -100, 200, -200]);
  });
});

/** 确定性伪随机 PCM（便于逐字节比对），范围约 [-10000, 10000] */
const makePcm = (frames: number, channels: number, seed: number): Int16Array => {
  const pcm = new Int16Array(frames * channels);
  let s = seed >>> 0;
  for (let i = 0; i < pcm.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    pcm[i] = ((s % 20001) | 0) - 10000;
  }
  return pcm;
};

const samePcm = (a: Int16Array, b: Int16Array): boolean => {
  if (a.length !== b.length) return false;
  const va = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const vb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
};

describe('FSB5 writer 往返（PCM16）', () => {
  const samples: FsbWriteSample[] = [
    // 单声道 44.1k：标准枚举、无 extra chunk（8 字节头，专测 parser 的 extra_param=0 分支）
    { name: 'mono_44k', pcm: makePcm(1000, 1, 1), channels: 1, sampleRate: 44100 },
    // 立体声 22.05k
    { name: 'stereo_22k', pcm: makePcm(2000, 2, 2), channels: 2, sampleRate: 22050 },
    // 3 声道 + 12345Hz（非标准采样率）→ 触发 channels + frequency 两个 extra chunk
    { name: 'threech_12345', pcm: makePcm(500, 3, 3), channels: 3, sampleRate: 12345 },
    // 带循环
    { name: 'looped', pcm: makePcm(800, 1, 4), channels: 1, sampleRate: 8000, loopStart: 10, loopEnd: 790 },
  ];

  const fsb = writeFsb5(samples);

  it('产出的 FSB5 头字段正确', () => {
    const dv = new DataView(fsb.buffer, fsb.byteOffset, fsb.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x35425346); // 'FSB5'
    expect(dv.getUint32(8, true)).toBe(4); // numSamples
    expect(dv.getUint32(24, true)).toBe(2); // mode = PCM16
    expect(dv.getUint32(20, true)).toBeGreaterThan(0); // dataSize
  });

  it('重新解析出的元数据与输入一致', () => {
    const r = parseFsbBank(fsb, 0);
    expect(r).not.toBeNull();
    const { samples: got } = r!;
    expect(got.length).toBe(4);
    expect(got[0].name).toBe('mono_44k');
    expect(got[0].channels).toBe(1);
    expect(got[0].frequency).toBe(44100);
    expect(got[0].sampleCount).toBe(1000);
    expect(got[2].name).toBe('threech_12345');
    expect(got[2].channels).toBe(3);
    expect(got[2].frequency).toBe(12345);
    expect(got[3].name).toBe('looped');
    expect(got[3].sampleCount).toBe(800);
  });

  it('每个子音频的 PCM 与输入逐字节一致', () => {
    samples.forEach((s, i) => {
      const ext = extractFsbSamplePcm(fsb, i);
      expect(ext).not.toBeNull();
      expect(ext!.channels).toBe(s.channels);
      expect(ext!.sampleRate).toBe(s.sampleRate);
      expect(samePcm(ext!.pcm, s.pcm)).toBe(true);
    });
  });

  it('空样本列表应安全产出最小合法头', () => {
    const empty = writeFsb5([]);
    expect(empty.length).toBeGreaterThanOrEqual(60);
    const dv = new DataView(empty.buffer, empty.byteOffset, empty.byteLength);
    expect(dv.getUint32(8, true)).toBe(0);
  });
});

describe('FSB5 写回 RIFF/.bank 容器', () => {
  const samples: FsbWriteSample[] = [
    { name: 'a', pcm: makePcm(300, 2, 11), channels: 2, sampleRate: 48000 },
    { name: 'b', pcm: makePcm(300, 1, 22), channels: 1, sampleRate: 44100 },
  ];
  const newFsb = writeFsb5(samples);

  it('保留 RIFF 前缀并 patch SND/RIFF size 字段，内嵌 FSB5 仍可解析', () => {
    // 构造：RIFF<size> + "FBK " + 若干元数据 + "SND "<size>  (FSB5 起始处即 prefix 末尾)
    const meta = new Uint8Array(8); // 模拟 DEL/MUSE 之类的前置 chunk 数据
    const prefix = new Uint8Array(4 + 4 + 4 + meta.length + 4 + 4);
    const pdv = new DataView(prefix.buffer);
    prefix[0] = 0x52; // R
    prefix[1] = 0x49; // I
    prefix[2] = 0x46; // F
    prefix[3] = 0x46; // F
    prefix[4 + 4] = 0x46; // F  -> "FBK "
    prefix[4 + 4 + 1] = 0x42;
    prefix[4 + 4 + 2] = 0x4b;
    prefix[4 + 4 + 3] = 0x20;
    // "SND " 紧跟在 meta 之后
    const sndTag = 4 + 4 + 4 + meta.length;
    prefix[sndTag] = 0x53; // S
    prefix[sndTag + 1] = 0x4e; // N
    prefix[sndTag + 2] = 0x44; // D
    prefix[sndTag + 3] = 0x20; // space
    // 先把 size 占位写 0，wrap 时应被 patch
    pdv.setUint32(sndTag + 4, 0, true);
    pdv.setUint32(4, 0, true);

    const fsbOffset = prefix.length;
    const wrap = wrapFsbInContainer(prefix, fsbOffset, newFsb);
    const out = wrap.bytes;

    // SND size 被 patch 为新 FSB5 长度
    const patchedSnd = new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(sndTag + 4, true);
    expect(patchedSnd).toBe(newFsb.length);
    // RIFF size 被 patch 为总长 - 8
    const patchedRiff = new DataView(out.buffer, out.byteOffset, out.byteLength).getUint32(4, true);
    expect(patchedRiff).toBe(out.length - 8);

    // 内嵌 FSB5 仍可解析
    const embedded = out.subarray(fsbOffset);
    const r = parseFsbBank(embedded, 0);
    expect(r).not.toBeNull();
    expect(r!.samples.length).toBe(2);
    const ext = extractFsbSamplePcm(embedded, 0);
    expect(ext).not.toBeNull();
    expect(samePcm(ext!.pcm, samples[0].pcm)).toBe(true);
  });
});
