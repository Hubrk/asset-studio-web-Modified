/**
 * 主线程音频解码：把用户上传的音频文件（wav/mp3/ogg/m4a…）解码成交错 PCM16。
 * 供 FSB bank 样本替换使用。必须在主线程执行（依赖 Web Audio 的 AudioContext）。
 */

export interface DecodedPcm {
  /** 交错 PCM16（int16 LE），长度 = frames * channels */
  pcm: Int16Array;
  channels: number;
  sampleRate: number;
}

export const decodeAudioFileToPcm = async (file: Blob): Promise<DecodedPcm> => {
  const arrayBuffer = await file.arrayBuffer();
  if (!arrayBuffer.byteLength) throw new Error('文件为空，无法解码');
  const Ctx: typeof AudioContext =
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('当前浏览器不支持 Web Audio 解码');
  const ctx = new Ctx();
  try {
    let audioBuffer: AudioBuffer;
    try {
      // decodeAudioData 会 detach 传入的 buffer，这里 slice 一份副本避免影响原 file
      audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } catch {
      throw new Error('无法解码该音频：格式不受支持或文件已损坏');
    }
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const frames = audioBuffer.length;
    // 健壮性：解出空数据 / 非法声道时给出明确错误，而不是生成一个坏的 WAV
    if (!channels || channels < 1) throw new Error('音频声道数为 0，解码失败');
    if (!frames || frames < 1) throw new Error('音频解码结果为空');
    const pcm = new Int16Array(frames * channels);
    const chans: Float32Array[] = [];
    for (let c = 0; c < channels; c++) chans.push(audioBuffer.getChannelData(c));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        let s = chans[c][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        pcm[i * channels + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    return { pcm, channels, sampleRate };
  } finally {
    ctx.close();
  }
};

/**
 * 把交错 PCM16 重采样到目标声道数 + 采样率（"替换保真"核心：
 * 让替换音贴合原样本的声道/采样率，使重打包后的样本无缝槽入原 bank）。
 * 用 OfflineAudioContext 渲染完成 SRC + 声道混流（Web Audio 自动按目标声道数 up/down mix）。
 * 若源格式与目标格式一致则零拷贝原样返回。
 */
export const resamplePcm16 = async (
  pcm: Int16Array,
  fromChannels: number,
  fromRate: number,
  toChannels: number,
  toRate: number,
): Promise<{ pcm: Int16Array; channels: number; sampleRate: number }> => {
  if (fromChannels === toChannels && fromRate === toRate) {
    return { pcm, channels: toChannels, sampleRate: toRate };
  }
  const frames = Math.floor(pcm.length / fromChannels);
  if (frames <= 0) return { pcm, channels: toChannels, sampleRate: toRate };

  const OfflineCtx: typeof OfflineAudioContext =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  // 环境不支持离线条渲染：放弃重采样，回退到原始 PCM（调用方按原生格式处理）
  if (!OfflineCtx) return { pcm, channels: fromChannels, sampleRate: fromRate };

  const outFrames = Math.max(1, Math.round((frames * toRate) / fromRate));
  const off = new OfflineCtx(toChannels, outFrames, toRate);

  const srcBuf = off.createBuffer(fromChannels, frames, fromRate);
  for (let c = 0; c < fromChannels; c++) {
    const ch = srcBuf.getChannelData(c);
    for (let i = 0; i < frames; i++) ch[i] = pcm[i * fromChannels + c] / 32768;
  }
  const src = off.createBufferSource();
  src.buffer = srcBuf;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();

  const out = new Int16Array(rendered.length * toChannels);
  for (let c = 0; c < toChannels; c++) {
    const ch = rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1));
    for (let i = 0; i < rendered.length; i++) {
      let s = ch[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      out[i * toChannels + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return { pcm: out, channels: toChannels, sampleRate: toRate };
};

/** 把交错 PCM16 封装成可播放的 WAV Blob（用于替换样本的即时试听）。 */
export const pcmToWavBlob = (pcm: Int16Array, channels: number, sampleRate: number): Blob => {
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bytesPerSample) | 0, true);
  view.setUint16(32, (channels * bytesPerSample) | 0, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buffer, 44, pcm.length).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
};