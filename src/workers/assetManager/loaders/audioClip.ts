import type { AudioClip, AudioClipGetResult } from '@arkntools/unity-js';
import type { FsbConvertFormat } from '@arkntools/unity-js/audio';
import { blobCache } from '../utils/cache';
import type { CacheKey } from '../utils/cache';
import { AssetLoader, PreviewType } from './default';
import type { AssetExportItem, PreviewDetail } from './default';

const mimeMap: Record<string, string | undefined> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};

const getMimeType = (format: string) => mimeMap[format] ?? `audio/${format}`;

export class AudioClipLoader extends AssetLoader<AudioClip> {
  static fsbConverter: (params: AudioClipGetResult, isPreview?: boolean) => Promise<Uint8Array<ArrayBuffer>>;
  static convertFormat: FsbConvertFormat;
  /** 独立 FSB bank 的子音频解码器（主线程 FMOD WASM，经 Comlink 回传）：
   *  入参 (bank 字节, 长度, 声道数, 子音频下标, 期望采样率)，返回 16-bit PCM WAV。 */
  static fsbSubConverter?: (
    data: Uint8Array,
    size: number,
    channels: number,
    index: number,
    sampleRate?: number,
  ) => Promise<Uint8Array<ArrayBuffer>>;

  private get cacheKey(): CacheKey {
    return {
      pathId: this.object.pathId,
    };
  }

  override canExport(): boolean {
    return true;
  }

  override async export(): Promise<AssetExportItem[] | null> {
    const { convertFormat } = AudioClipLoader;
    let blob = blobCache.get(this.cacheKey)?.blob;

    if (convertFormat !== 'wav' || !blob) {
      blob = await this.getAudioBlob();
      if (!blob) return null;
    }

    const ext = this.object.format === 'fsb' ? convertFormat : this.object.format;

    return [
      {
        name: `${this.objNameForFile}.${ext}`,
        blob,
      },
    ];
  }

  override getPreviewDetail(): PreviewDetail {
    return { type: PreviewType.Audio };
  }

  override async getPreviewData() {
    const key = this.cacheKey;
    const cachedUrl = blobCache.get(key)?.url;
    if (cachedUrl) return cachedUrl;

    const blob = await this.getAudioBlob(true);
    if (!blob) return null;

    const url = URL.createObjectURL(blob);
    blobCache.set(key, { blob, url });
    return url;
  }

  private async getAudioBlob(isPreview?: boolean) {
    const audio = this.object.getAudio();

    try {
      return new Blob([audio.format === 'fsb' ? await AudioClipLoader.fsbConverter(audio, isPreview) : audio.data], {
        type:
          audio.format === 'fsb'
            ? isPreview
              ? mimeMap.wav
              : getMimeType(AudioClipLoader.convertFormat)
            : getMimeType(audio.format),
      });
    } catch (error) {
      console.error(error);
    }
  }
}
