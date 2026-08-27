import { AssetType, ArrayBufferWriter, BundleFile, loadAssetBundle, serializeFromTypeTree, Sprite, TextAsset, Texture2D, TextureFormat } from '@arkntools/unity-js';
import type { AssetFile, AssetFileLoadOptions, AssetObject, ObjectInfo } from '@arkntools/unity-js';
import type { FsbConvertFormat } from '@arkntools/unity-js/audio';
import { FsaError, FsaErrorCode, FsaPromises } from '@tsuk1ko/fsa-promises';
import { expose, transfer } from 'comlink';
import { md5 as calcMd5 } from 'js-md5';
import { ExportGroupMethod } from '@/types/export';
import type { RepoBatchDataHandler, RepoDataHandler } from '@/types/repository';
import { decryptKhBundle, isKhBundle, isUnityFs, splitKhBundle, type KhBundleMeta } from '@/utils/khDecrypt';
import { encryptUnityFsToKh, computeCrc32Patch, CRC32_TABLE } from '@/utils/khEncrypt';
import { PromisePool } from '@/utils/promisePool';
import { bleedAlpha, encodeTextureWithMips, flipVerticalRgba, isFormatSupported, sharpenRgba, SHARPEN_PRESETS } from '@/utils/textureEncoder';
import { clearCache, createLoader, PreviewType } from './loaders';
import type { AssetExportItem, PreviewInfo } from './loaders';
import { AudioClipLoader } from './loaders/audioClip';
import { detectFsbBank, parseFsbBank, makeFsbSampleObject, createFsbAssetInfos } from './loaders/fsbBank';
import { repackFsb5Incremental } from './loaders/fsbRepack';
import {
  writeFsb5,
  wavToPcm16,
  wrapFsbInContainer,
  type FsbWriteSample,
} from './loaders/fsbWriter';
import type { FsbSampleMeta } from '@/types/preview';
import { RenameProcessor, type DuplicateNameStyle } from './utils/rename';
import { detectRawImage, imageMimeOf } from './utils/is';

export interface AssetInfo {
  key: string;
  fileId: string;
  fileName: string;
  name: string;
  container: string;
  type: string;
  pathId: bigint;
  size: number;
  preview: PreviewInfo;
  canExport: boolean;
  search: string[];
}

export interface FileLoadingError {
  name: string;
  error: string;
}

export type FileLoadingOnProgress = (param: { name: string; progress: number; totalAssetNum: number }) => any;

export type ExportAssetsOnProgress = (param: { progress: number; name: string }) => any;

type ObjectPathGetter = (obj: AssetObject, fileName: string) => string;

const THREAD_NUM = Math.max(navigator.hardwareConcurrency, 1);

export class AssetManager {
  /** 返回 worker 实际加载的代码版本（vite define 注入），用于排查"页面新但 worker 旧"的缓存问题 */
  getVersion(): string {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  }

  private bundleMap = new Map<string, AssetFile>();
  private unityFsMap = new Map<string, ArrayBuffer>();
  // 原始（未改动）bundle 字节：KFB 写回走 encryptBundle 链路时必须基于 pristine 字节，
  // 否则反复 apply 会基于 @arkntools 重建产物（格式不兼容我们的 parse）。
  private pristineMap = new Map<string, Uint8Array>();
  private khMetaMap = new Map<string, KhBundleMeta>();
  private fileNameMap = new Map<string, string>();
  private khMetaByFileName = new Map<string, KhBundleMeta>();
  private modifiedAssets = new Set<string>();
  /**
   * 写回 bundle 的压缩模式：CompressionType 值
   * 3=LZ4_HC(游戏兼容) | 2=LZ4 | 0=NONE(默认,不压缩)。由 UI 选择，rebuild 时传入。
   */
  private compressionMode = 0;
  /** 导出重名文件去重后缀风格：'paren'（foo (2).png）| 'underscore'（foo_2.png），由导出选项设置 */
  private renameStyle: DuplicateNameStyle = 'paren';
  /** KFB 自动匹配 key 缓存：fileId → 已命中的 key，避免每次打开重复遍历内置 key 库 */
  private kfbKeyCache = new Map<string, string>();
  /** 独立 FSB bank：fileId → 元数据 + 原始容器字节 + 样本替换表 */
  private fsbBankMap = new Map<
    string,
    {
      fileName: string;
      /** 截取的 FSB5 字节（对 .bank 是原始文件的 subarray 视图，故原始容器随之保留） */
      fsbBytes: Uint8Array;
      /** 原始完整文件字节（.bank 容器）。裸 FSB5 时与 fsbBytes 指向同一数据 */
      containerBytes: Uint8Array;
      /** FSB5 在原始文件中的起始偏移（裸 FSB5 为 0） */
      fsbOffset: number;
      samples: FsbSampleMeta[];
      /** 已替换的样本：index → 用户上传并解码后的 PCM16 */
      replacements: Map<number, { pcm: Int16Array; channels: number; sampleRate: number }>;
    }
  >();
  /** 独立位图文件：fileId → 原始字节 + 原文件名（裸 PNG/JPEG/WebP 直导，不走 Unity bundle） */
  private imageFileMap = new Map<string, { bytes: Uint8Array; name: string }>();
  /** 位图预览 URL 缓存（clear() 时统一 revoke） */
  private imageUrlCache = new Map<string, string>();

  static setFsbConverter(fsbConverter: (typeof AudioClipLoader)['fsbConverter']) {
    AudioClipLoader.fsbConverter = fsbConverter;
  }

  static setFsbConvertFormat(fsbConvertFormat: FsbConvertFormat) {
    AudioClipLoader.convertFormat = fsbConvertFormat;
  }

  /** 注册主线程的「独立 FSB 子音频解码器」，供 AudioClipLoader 在子音频分支调用 */
  static setFsbSubConverter(
    fsbSubConverter: NonNullable<(typeof AudioClipLoader)['fsbSubConverter']>,
  ) {
    AudioClipLoader.fsbSubConverter = fsbSubConverter;
  }

  /** 记录用户在主线程上传并解码后的某个子音频替换 PCM（仅存于内存，导出时合并） */
  setFsbSampleReplacement(
    fileId: string,
    index: number,
    pcm: Int16Array,
    channels: number,
    sampleRate: number,
  ): void {
    const fsb = this.fsbBankMap.get(fileId);
    if (!fsb) return;
    fsb.replacements.set(index, { pcm, channels, sampleRate });
    console.log(`[AssetManager] FSB bank ${fileId}: 已记录样本 #${index} 的替换 PCM`);
  }

  /**
   * 重打包并导出 bank。
   *
   * 首选「增量重打包」（bank 为 Vorbis 或 PCM16 时）：
   *   未替换的样本连同它的 extra chunk 与数据区一起字节级原样搬运，只有被替换的样本重新编码，
   *   Vorbis bank 用 libvorbis 重编码并自动挑选让 setup CRC32 命中原 bank 已用值的 quality，
   *   PCM16 bank 直接重写替换样本的 PCM 数据。这样体积几乎不变，没动过的音频零损伤。
   *
   * 回退「全量 PCM16」：增量路径抛错时使用。逐条经 FMOD 解码为 PCM16 再写回，
   *   必然能播但体积会涨 5~10 倍。
   *
   * 若原始文件是 .bank 等容器（fsbOffset>0），把新 FSB5 写回容器并 patch 各 size 字段，
   * 并同步前缀里按帧数缓存的事件时长标记（否则游戏按旧时长截断播放）。
   */
  async exportFsbBank(fileId: string): Promise<{ name: string; data: Uint8Array } | null> {
    const fsb = this.fsbBankMap.get(fileId);
    if (!fsb) return null;

    // 零替换：直接原样返回，避免无谓的 Vorbis→PCM16 重编码（保真 + 不膨胀 + 不引入噪声）
    if (fsb.replacements.size === 0) {
      const src = fsb.containerBytes && fsb.fsbOffset > 0 ? fsb.containerBytes : fsb.fsbBytes;
      const data = src.slice();
      console.log(`[AssetManager] FSB bank ${fileId}: 无替换，原样导出（${data.length} 字节）`);
      // 单次拷贝 + 转移其 buffer（零拷贝跨 worker）。原写法多 .slice() 两次且 transfer 的是被丢弃副本的
      // buffer，导致真正返回的 data 未被转移而走了结构化克隆，既浪费又慢。
      return transfer({ name: fsb.fileName, data }, [data.buffer as ArrayBuffer]);
    }

    // 被替换样本的新旧帧数：写回容器时用于同步前缀里的时长标记
    let rawPairs: Array<{ index: number; oldFrames: number; newFrames: number }> = [];

    // ---- 首选：增量重打包（Vorbis / PCM16 bank 均可） ----
    try {
      const t0 = Date.now();
      const { fsb: newFsb, report } = await repackFsb5Incremental(fsb.fsbBytes, fsb.replacements);
      let out = newFsb;
      let lengthPatched = 0;
      if (fsb.containerBytes && fsb.fsbOffset > 0) {
        // 采样率变了的替换样本不参与时长标记同步（标记单位是帧数，换率后无法可靠换算）
        rawPairs = Object.entries(report.lengthPatchByIndex)
          .map(([k, v]) => ({ index: Number(k), ...v }))
          .filter((p) => {
            const conv = report.convertedByIndex[p.index];
            return !conv || conv.fromRate === conv.toRate;
          });
        // 时长标记同步过滤：旧帧数与未替换样本撞值、或多条替换共用同一旧帧数时跳过（按值匹配会误伤）
        const replacedIdx = new Set(rawPairs.map((p) => p.index));
        const oldCount = new Map<number, number>();
        rawPairs.forEach((p) => oldCount.set(p.oldFrames, (oldCount.get(p.oldFrames) ?? 0) + 1));
        const lengthPairs = rawPairs.filter((p) => {
          if ((oldCount.get(p.oldFrames) ?? 0) > 1) return false;
          return !fsb.samples.some((s, i) => i !== p.index && !replacedIdx.has(i) && s.sampleCount === p.oldFrames);
        });
        const wrap = wrapFsbInContainer(fsb.containerBytes, fsb.fsbOffset, out, {
          oldFsbSize: fsb.fsbBytes.length,
          lengthPairs,
        });
        out = wrap.bytes;
        lengthPatched = wrap.lengthPatched;
      }
      const detail = Object.keys(report.crcByIndex)
        .map((k) => `#${k}(q=${report.qualityByIndex[Number(k)]}, crc=${report.crcByIndex[Number(k)]})`)
        .join(' ');
      const convN = Object.keys(report.convertedByIndex).length;
      const droppedN = Object.keys(report.droppedLoopByIndex).length;
      console.log(
        `[AssetManager] FSB bank ${fileId}: 增量重打包完成，${Date.now() - t0}ms，` +
          `FSB5 ${report.originalSize}→${report.newSize} 字节，输出 ${out.length} 字节；` +
          `替换 ${detail}${convN ? `；${convN} 条格式转换` : ''}${droppedN ? `；${droppedN} 条丢弃失效 loop` : ''}` +
          (lengthPatched > 0 ? `；同步 ${lengthPatched} 处容器时长标记` : ''),
      );
      return transfer({ name: fsb.fileName, data: out }, [out.buffer as ArrayBuffer]);
    } catch (e) {
      console.warn('[AssetManager] 增量重打包失败，回退到 PCM16 全量重编码：', e);
    }

    // ---- 回退：全量 PCM16 ----
    const writeSamples: FsbWriteSample[] = [];
    for (const meta of fsb.samples) {
      const repl = fsb.replacements.get(meta.index);
      if (repl) {
        writeSamples.push({ name: meta.name, pcm: repl.pcm, channels: repl.channels, sampleRate: repl.sampleRate });
        // 与 writeFsb5 的 frameCount 算法一致；采样率变了的样本不参与时长标记同步
        if (meta.frequency === repl.sampleRate) {
          rawPairs.push({
            index: meta.index,
            oldFrames: meta.sampleCount,
            newFrames: Math.floor(repl.pcm.length / repl.channels),
          });
        }
      } else {
        const converter = AudioClipLoader.fsbSubConverter;
        if (!converter) throw new Error('FSB 子音频解码器未初始化');
        // 以原始头部采样率作为权威速率解码（targetSampleRate=meta.frequency），
        // 强制 FMOD 按该速率输出 PCM，避免 getDefaults 返回系统混音率导致「倍速播放」；
        // 写回时也用 meta.frequency 作为 tag，确保头标记速率 == 实际 PCM 速率。
        const wav = await converter(fsb.fsbBytes, fsb.fsbBytes.length, meta.channels, meta.index, meta.frequency);
        // 诊断：记录源 WAV 真实位深/格式，便于排查「嘶嘶嘶」类噪声
        const wdv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
        const wFmt = wdv.getUint16(20, true);
        const wBits = wdv.getUint16(34, true);
        if (wFmt !== 1 || wBits !== 16) {
          console.warn(
            `[AssetManager] 样本 #${meta.index} 源 WAV 非 16-bit PCM(format=${wFmt}, bits=${wBits})，已转换为 PCM16`,
          );
        }
        const { pcm, channels } = wavToPcm16(wav);
        writeSamples.push({ name: meta.name, pcm, channels, sampleRate: meta.frequency });
      }
    }

    let out = writeFsb5(writeSamples);
    let lengthPatched = 0;
    if (fsb.containerBytes && fsb.fsbOffset > 0) {
      const lengthPairs = rawPairs.filter((p) => p.oldFrames !== p.newFrames);
      const wrap = wrapFsbInContainer(fsb.containerBytes, fsb.fsbOffset, out, {
        oldFsbSize: fsb.fsbBytes.length,
        lengthPairs,
      });
      out = wrap.bytes;
      lengthPatched = wrap.lengthPatched;
    }
    console.log(
      `[AssetManager] FSB bank ${fileId}: 重打包为 PCM16，输出 ${out.length} 字节` +
        (lengthPatched > 0 ? `；同步 ${lengthPatched} 处容器时长标记` : ''),
    );
    return transfer({ name: fsb.fileName, data: out }, [out.buffer as ArrayBuffer]);
  }

  clear() {
    this.bundleMap.clear();
    this.unityFsMap.clear();
    this.khMetaMap.clear();
    this.khMetaByFileName.clear();
    this.fileNameMap.clear();
    this.pristineMap.clear();
    this.modifiedAssets.clear();
    this.fsbBankMap.clear();
    for (const url of this.imageUrlCache.values()) URL.revokeObjectURL(url);
    this.imageUrlCache.clear();
    this.imageFileMap.clear();
    clearCache();
  }

  async loadFiles(files: File[], options: AssetFileLoadOptions, onProgress?: FileLoadingOnProgress) {
    const errors: Array<FileLoadingError> = [];
    const infos: AssetInfo[] = [];
    const usedKeys = new Set<string>();
    let successNum = 0;
    let done = 0;

    // 并发加载：利用多核解码多个 bundle，总耗时不再等于各文件之和。
    // usedKeys 去重/infos/errors/successNum 的写操作都在各自 handler 的同步块内完成，
    // JS 单线程下不会交错，故并发安全。
    const pool = new PromisePool<File, void>(
      THREAD_NUM,
      async (file: File) => {
        try {
          const timeLabel = `[AssetManager] load ${file.name}`;
          console.time(timeLabel);
          const result = await this.loadFile(file, options);
          console.timeEnd(timeLabel);
          console.log(`[AssetManager] ${result.length} assets loaded from ${file.name}`);
          if (result.length) {
            successNum++;
            for (const info of result) {
              if (usedKeys.has(info.key)) continue;
              usedKeys.add(info.key);
              infos.push(info);
            }
          }
        } catch (error) {
          errors.push({ name: file.name, error: String(error) });
          console.error(`[AssetManager] failed to load ${file.name}`);
          console.error(error);
        } finally {
          done++;
          onProgress?.({
            name: file.name,
            progress: (done / files.length) * 100,
            totalAssetNum: infos.length,
          });
        }
      },
    );
    pool.addTasks(files);
    await pool.wait();

    return { errors, infos, successNum };
  }

  async getPreviewData(fileId: string, pathId: bigint, payload?: any, dataHandler?: RepoDataHandler) {
    // 独立位图文件：直接用原始字节生成预览 URL
    const img = this.imageFileMap.get(fileId);
    if (img) {
      const cached = this.imageUrlCache.get(fileId);
      if (cached) return cached;
      const blob = new Blob([img.bytes.slice()], { type: imageMimeOf(img.name) });
      const url = URL.createObjectURL(blob);
      this.imageUrlCache.set(fileId, url);
      return url;
    }
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return null;
    return await createLoader(obj, { objects: this.getBundleObjects(fileId), sessionObjects: this.getSessionSprites(), fileId }).getPreviewData(payload, dataHandler);
  }

  async exportAsset(
    handle: FileSystemDirectoryHandle,
    fileId: string,
    pathId: bigint,
    dataHandler?: RepoDataHandler,
    customName?: string,
  ) {
    // 独立位图文件：原样写回（不改名/不转码）
    const img = this.imageFileMap.get(fileId);
    if (img) {
      const fs = new FsaPromises({ root: handle, cacheDirHandle: true });
      const blob = new Blob([img.bytes.slice()], { type: imageMimeOf(img.name) });
      try {
        await fs.writeFile(img.name, blob, { flag: 'wx', ensureDir: true });
        return { success: 1, skip: 0, error: 0 };
      } catch (e) {
        if (e instanceof FsaError && e.code === FsaErrorCode.EEXIST) {
          console.warn(`[AssetManager] file ${img.name} already exists, skip`);
          return { success: 0, skip: 1, error: 0 };
        }
        console.error(`[AssetManager] failed to export ${img.name}`, e);
        return { success: 0, skip: 0, error: 1 };
      }
    }
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return;
    const loader = createLoader(obj, { objects: this.getBundleObjects(fileId), sessionObjects: this.getSessionSprites(), fileId });
    if (!loader.canExport()) return;
    const items = await loader.export(dataHandler);
    if (!items?.length) return;

    const finalItems = customName
      ? items.map(item => {
          const ext = item.name.split('.').pop() || 'png';
          return { ...item, name: `${customName}.${ext}` };
        })
      : items;

    let success = 0;
    const { errorStat, errorHandler } = this.createWriteFileErrorHandler();
    const fs = new FsaPromises({ root: handle, cacheDirHandle: true });
    const pool = new PromisePool(
      THREAD_NUM,
      async ({ name, blob }: AssetExportItem) => {
        await fs.writeFile(name, blob, { flag: 'wx', ensureDir: true });
        success++;
      },
      errorHandler,
    );
    pool.addTasks(new RenameProcessor(this.renameStyle).process(finalItems));
    await pool.wait();

    return { success, ...errorStat };
  }

  async exportAssets(
    handle: FileSystemDirectoryHandle,
    params: Array<{ fileId: string; pathId: bigint; fileName: string; hasDataHandler: boolean }>,
    { groupMethod }: { groupMethod: ExportGroupMethod },
    onProgress: ExportAssetsOnProgress,
    dataHandler: RepoBatchDataHandler,
  ) {
    let totalNum = params.length;
    let finishedNum = 0;

    const minusTotalNum = () => { totalNum--; };

    let success = 0;
    const { errorStat, errorHandler } = this.createWriteFileErrorHandler();
    const fs = new FsaPromises({ root: handle, cacheDirHandle: true });
    const pool = new PromisePool(
      THREAD_NUM,
      async ({ name, blob }: AssetExportItem) => {
        onProgress({ progress: ++finishedNum / totalNum, name });
        await fs.writeFile(name, blob, { flag: 'wx', ensureDir: true });
        success++;
      },
      errorHandler,
    );

    const renameProcessor = new RenameProcessor(this.renameStyle);
    const objPathGetter = this.createObjPathGetter(groupMethod);

    await Promise.all(
      params.map(async ({ fileId, pathId, fileName, hasDataHandler }, i) => {
        // 独立位图文件：原样写回
        const img = this.imageFileMap.get(fileId);
        if (img) {
          try {
            await fs.writeFile(
              img.name,
              new Blob([img.bytes.slice()], { type: imageMimeOf(img.name) }),
              { flag: 'wx', ensureDir: true },
            );
            success++;
          } catch (e) {
            if (e instanceof FsaError && e.code === FsaErrorCode.EEXIST) {
              errorStat.skip++;
              console.warn(`[AssetManager] file ${img.name} already exists, skip`);
            } else {
              errorStat.error++;
              console.error(`[AssetManager] failed to export ${img.name}`, e);
            }
          }
          return minusTotalNum();
        }
        const obj = this.getAssetObj(fileId, pathId);
        if (!obj) return minusTotalNum();
        const loader = createLoader(obj, { objects: this.getBundleObjects(fileId), sessionObjects: this.getSessionSprites(), fileId });
        if (!loader.canExport()) return minusTotalNum();
        const items = await loader.export(hasDataHandler ? data => dataHandler(data, i) : undefined);
        if (!items?.length) return minusTotalNum();
        if (items.length > 1) totalNum += items.length - 1;
        pool.addTasks(renameProcessor.process(items, objPathGetter(obj, fileName)));
      }),
    );

    await pool.wait();

    return { success, ...errorStat };
  }

  /**
   * 取单个资产导出内容的字节数据（不写磁盘），供主线程打包成 zip 下载。
   * 与 exportAsset 的区别：后者把内容写入目录（需桌面端 File System Access API），
   * 本方法把 Blob 转为 Uint8Array 并 transfer 回主线程，浏览器端即可直接下载 zip。
   */
  async getAssetExportData(fileId: string, pathId: bigint, dataHandler?: RepoDataHandler) {
    // 独立位图文件：原样返回字节（打包 zip / 导出用）
    const img = this.imageFileMap.get(fileId);
    if (img) {
      const data = img.bytes.slice();
      return transfer([{ name: img.name, data }], [data.buffer as ArrayBuffer]);
    }
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return null;
    const loader = createLoader(obj, {
      objects: this.getBundleObjects(fileId),
      sessionObjects: this.getSessionSprites(),
      fileId,
    });
    if (!loader.canExport()) return null;
    const items = await loader.export(dataHandler);
    if (!items?.length) return null;
    const result = await Promise.all(
      items.map(async ({ name, blob }) => ({ name, data: new Uint8Array(await blob.arrayBuffer()) })),
    );
    // 转移字节缓冲区所有权，避免跨 worker 拷贝大图
    return transfer(result, result.map(({ data }) => data.buffer as ArrayBuffer));
  }

  /**
   * 取加密 KH bundle 的原始加密文件字节（整 bundle 重新加密回 KH 格式）。
   * 供「导出为 ZIP」使用：当资产来自已加密的 bundle 时，导出的是原加密文件，
   * 而非解密后的明文资产内容。
   * 返回 null 表示该 fileId 不是加密 bundle。
   */
  async getEncryptedBundleData(fileId: string): Promise<{ name: string; data: Uint8Array } | null> {
    if (!this.isKhBundle(fileId)) return null;
    const enc = await this.encryptBundleToKh(fileId);
    if (!enc) return null;
    const name = this.fileNameMap.get(fileId) || `${fileId}.bundle`;
    return { name, data: new Uint8Array(enc) };
  }

  private getAssetObj(fileId: string, pathId: bigint) {
    // 独立 FSB bank：合成一个「伪装 AudioClip」对象，由 AudioClipLoader 走统一预览/导出
    const fsb = this.fsbBankMap.get(fileId);
    if (fsb) {
      const idx = Number(pathId);
      if (!Number.isNaN(idx) && idx >= 0) {
        const meta = fsb.samples[idx];
        if (meta) return makeFsbSampleObject(fsb.fsbBytes, meta);
      }
      return undefined;
    }
    return this.bundleMap.get(fileId)?.objectMap.get(pathId);
  }

  /** 取某文件内全部对象（供 loader 聚合兄弟资源，如 Texture2D 图集 + 同源 Sprite） */
  private getBundleObjects(fileId: string) {
    return this.bundleMap.get(fileId)?.objects;
  }

  /** 取同会话内所有已加载 bundle 的 Sprite 对象（用于帧动画跨 bundle 聚合，拼出完整序列） */
  private getSessionSprites(): AssetObject[] {
    const sprites: AssetObject[] = [];
    for (const bundle of this.bundleMap.values()) {
      for (const o of bundle.objects) {
        if (o.type === AssetType.Sprite) sprites.push(o);
      }
    }
    return sprites;
  }

  private async loadFile(file: File, options?: AssetFileLoadOptions) {
    let buffer = await file.arrayBuffer();
    const isKh = isKhBundle(buffer);
    let khMeta: KhBundleMeta | undefined;
    if (isKh) {
      khMeta = splitKhBundle(buffer);
      buffer = decryptKhBundle(buffer);
      console.log(`[AssetManager] Decrypted KH bundle: ${file.name}`);
      this.khMetaByFileName.set(file.name, khMeta);
    } else if (isUnityFs(buffer)) {
      const matchedMeta = this.findMetaByFileName(file.name);
      if (matchedMeta) {
        khMeta = matchedMeta;
        console.log(`[AssetManager] Reused KH meta for modified file: ${file.name}`);
      }
    }

    // 独立 FSB bank：裸 FSB5 或 .fsb/.bank 内嵌 FSB5。拆成「每个子音频一条资产」，不走 Unity bundle 解析。
    const fileBytes = new Uint8Array(buffer);
    const fsbOffset = detectFsbBank(fileBytes, file.name);
    if (fsbOffset !== null) {
      const parsed = parseFsbBank(fileBytes, fsbOffset);
      if (parsed && parsed.samples.length) {
        const md5 = calcMd5(parsed.fsbBytes);
        this.fsbBankMap.set(md5, {
          fileName: file.name,
          fsbBytes: parsed.fsbBytes,
          // fsbBytes 是 fileBytes 的 subarray 视图，故保留 fileBytes 即保留完整容器
          containerBytes: fileBytes,
          fsbOffset,
          samples: parsed.samples,
          replacements: new Map(),
        });
        console.log(`[AssetManager] Loaded FSB bank ${file.name}: ${parsed.samples.length} samples`);
        return createFsbAssetInfos(md5, file.name, parsed.fsbBytes, parsed.samples);
      }
      // 解析失败（非合法 FSB）→ 落到下方 Unity 解析，避免误吞文件
    }

    // 独立位图文件：裸 PNG/JPEG/WebP → 单条图像资产（不走 Unity bundle 解析）
    if (detectRawImage(fileBytes)) {
      const md5 = calcMd5(fileBytes);
      this.imageFileMap.set(md5, { bytes: fileBytes.slice(), name: file.name });
      const base = file.name.replace(/\.[^.]+$/, '');
      const info: AssetInfo = {
        key: `${md5}_0`,
        fileId: md5,
        fileName: file.name,
        name: base,
        container: '',
        type: 'Texture2D',
        pathId: 0n,
        size: fileBytes.length,
        preview: { type: PreviewType.Image, canEdit: false, typeTree: {}, inspect: {} },
        canExport: true,
        search: [base, file.name],
      };
      console.log(`[AssetManager] Loaded raw image ${file.name}`);
      return [info];
    }

    const pristineBuffer = buffer.slice(0);
    const md5 = calcMd5(pristineBuffer);

    const fileInfo = { fileId: md5, fileName: file.name };
    const bundle = this.bundleMap.get(md5) || (await loadAssetBundle(buffer, options));
    if (!this.bundleMap.has(md5)) {
      this.bundleMap.set(md5, bundle);
      this.unityFsMap.set(md5, pristineBuffer);
      // pristineMap 存字节视图（encryptBundle 需要 Uint8Array 语义），与 unityFsMap 共享同一份内存，只读用途
      this.pristineMap.set(md5, new Uint8Array(pristineBuffer));
      this.fileNameMap.set(md5, file.name);
      if (khMeta) this.khMetaMap.set(md5, khMeta);
    }

    return Promise.all(
      bundle.objects
        .filter(obj => obj.type !== AssetType.AssetBundle)
        .map(async (obj): Promise<AssetInfo> => {
          const { name, type, pathId, size } = obj;
          const container = bundle.getContainer(pathId);
          const loader = createLoader(obj, { objects: bundle.objects, sessionObjects: this.getSessionSprites() });
          return {
            ...fileInfo,
            key: `${fileInfo.fileId}_${pathId}`,
            name,
            container,
            type: AssetType[type] || '',
            pathId,
            size,
            preview: loader.getPreviewInfo(),
            canExport: loader.canExport(),
            search: [name, container, fileInfo.fileName],
          };
        }),
    );
  }

  /**
   * 取当前 bundle 字节，但**导出时按需按当前压缩模式重打包**。
   *
   * 关键修复：此前压缩模式只在 modifyTexture2D 保存那一刻写死进 unityFsMap，
   * 导出只是读存好的字节——导致「改完纹理再选压缩」「选完压缩没重新应用」时，
   * 下拉选择完全不生效（用户实测“选了压缩还是不压缩”）。
   * 现在改为导出时统一用 this.compressionMode 重打包，无论选择何时发生都生效。
   */
  async getUnityFs(fileId: string): Promise<ArrayBuffer | undefined> {
    const raw = this.unityFsMap.get(fileId);
    if (!raw || !isUnityFs(raw)) return raw;
    const bundle = await loadAssetBundle(raw.slice(0));
    return bundle.rebuild(this.compressionMode);
  }

  /**
   * 解密解压导出：固定输出**未压缩** UnityFS（compression=0），不受压缩模式下拉影响，
   * 便于 UABE 等工具直接编辑。（之前误用了 this.compressionMode，与“解压”语义相悖）
   */
  async getDecompressedUnityFs(fileId: string): Promise<ArrayBuffer | undefined> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) return undefined;
    const bundle = await loadAssetBundle(origFs.slice(0));
    return bundle.rebuild(0);
  }

  isKhBundle(fileId: string): boolean {
    return this.khMetaMap.has(fileId);
  }

  isAssetModified(fileId: string, pathId: bigint): boolean {
    return this.modifiedAssets.has(`${fileId}_${pathId}`);
  }

  getModifiedAssets(): string[] {
    return Array.from(this.modifiedAssets);
  }

  private static extractFileId(fileName: string): string {
    const baseName = fileName.replace(/\.[^.]+$/, '');
    const numbers = baseName.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      return numbers.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), '');
    }
    return baseName;
  }

  private findMetaByFileName(fileName: string): KhBundleMeta | undefined {
    const targetId = AssetManager.extractFileId(fileName);
    if (!targetId) return undefined;
    for (const [origFileName, meta] of this.khMetaByFileName) {
      if (AssetManager.extractFileId(origFileName) === targetId) {
        return meta;
      }
    }
    return undefined;
  }

  /**
   * 设置写回 bundle 的压缩模式（0=NONE, 2=LZ4, 3=LZ4_HC，其余忽略）。
   * 默认 LZ4_HC(3)——该游戏加载器只认 LZ4_HC。
   */
  setCompressionMode(mode: number): void {
    if (mode === 0 || mode === 2 || mode === 3) {
      this.compressionMode = mode;
    }
  }

  /** 设置导出重名文件去重后缀风格（'paren' 或 'underscore'），由 UI 导出选项同步 */
  setRenameStyle(style: DuplicateNameStyle): void {
    this.renameStyle = style;
  }

  /**
   * 将某个 bundle 恢复到最初加载时的原始字节（撤销所有修改）。
   *
   * 用于批量替换场景：不同文件夹的 bundle 内容可能完全相同（fileId 相同、worker 内只有一份数据），
   * 每个任务导出前恢复原始状态，即可实现「每个文件夹各自独立导出」而不互相叠加修改。
   */
  async restoreBundle(fileId: string): Promise<boolean> {
    const pristine = this.pristineMap.get(fileId);
    if (!pristine) return false;

    // pristineMap 与 unityFsMap 原本共享同一份内存，必须复制后再写入，防止后续修改污染原始字节
    const restored = pristine.slice().buffer as ArrayBuffer;
    this.unityFsMap.set(fileId, restored);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(restored.slice(0));
    this.bundleMap.set(fileId, newBundle);

    // 清除该 fileId 的修改标记与预览缓存
    for (const key of this.modifiedAssets) {
      if (key.startsWith(`${fileId}_`)) this.modifiedAssets.delete(key);
    }
    clearCache(fileId);
    return true;
  }

  async modifyTexture2D(
    fileId: string,
    pathId: bigint,
    rgbaData: ArrayBuffer,
    width: number,
    height: number,
    targetFormat?: TextureFormat,
    generateMips?: boolean,
    sharpenLevel = 0,
  ): Promise<boolean> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`modifyTexture2D: file ${fileId} not found`);

    const bundle = await loadAssetBundle(origFs.slice(0));

    const obj = bundle.objectMap.get(pathId);
    if (!obj) throw new Error(`modifyTexture2D: object ${pathId} not found in bundle`);
    if (obj.type !== AssetType.Texture2D) {
      throw new Error(`modifyTexture2D: object ${pathId} is not a Texture2D (type=${obj.type})`);
    }
    const tex = obj as Texture2D;

    const fmt: TextureFormat = targetFormat ?? tex.textureFormat;
    if (targetFormat !== undefined && targetFormat !== tex.textureFormat) {
      Object.defineProperty(tex, 'textureFormat', { value: targetFormat, writable: true, configurable: true });
      (tex as any)._modifiedTextureFormat = targetFormat;
    }

    if (width !== tex.width || height !== tex.height) {
      Object.defineProperty(tex, 'width', { value: width, writable: true, configurable: true });
      Object.defineProperty(tex, 'height', { value: height, writable: true, configurable: true });
    }

    if (!isFormatSupported(fmt)) {
      throw new Error(`modifyTexture2D: texture format ${TextureFormat[fmt] ?? fmt} is not supported for encoding`);
    }

    const flipped = flipVerticalRgba(new Uint8Array(rgbaData), width, height);
    // 可选锐化：sharpenLevel>0 时按 SHARPEN_PRESETS 应用 unsharp mask（0=不锐化）。
    // 单图编辑器在画布层自行锐化后传 0，批量替换可传档位。
    const sharpened = sharpenLevel > 0 ? sharpenRgba(flipped, width, height, SHARPEN_PRESETS[sharpenLevel]) : flipped;
    const rgba = bleedAlpha(sharpened, width, height);

    const originalDataSize = tex.streamData?.size ?? tex.dataSize;
    const targetDataSize = generateMips === false ? 0 : originalDataSize;
    const finalEncoded = encodeTextureWithMips(rgba, width, height, fmt, targetDataSize);

    if (tex.streamData) {
      const sPath = tex.streamData.path.split('/').pop()!;
      const nodeIndex = bundle.nodes.findIndex(n => n.path === sPath);
      if (nodeIndex === -1) throw new Error(`modifyTexture2D: cannot find stream node "${sPath}"`);

      const offset = tex.streamData.offset;
      const oldSize = tex.streamData.size;

      if (finalEncoded.length > oldSize) {
        const oldNodeData = new Uint8Array(bundle.files[nodeIndex]);
        const extraBytes = finalEncoded.length - oldSize;
        const tailStart = offset + oldSize;
        const tailData = tailStart < oldNodeData.length
          ? oldNodeData.slice(tailStart)
          : new Uint8Array(0);

        const newNodeData = new Uint8Array(oldNodeData.length + extraBytes);
        newNodeData.set(oldNodeData.slice(0, offset), 0);
        newNodeData.set(finalEncoded, offset);
        newNodeData.set(tailData, offset + finalEncoded.length);
        bundle.files[nodeIndex] = newNodeData.buffer;
      } else {
        const nodeData = new Uint8Array(bundle.files[nodeIndex]);
        nodeData.set(finalEncoded, offset);
        // 关键修复：数据缩小后必须截断节点缓冲区。resS 节点的 size 会被游戏用作
        // 纹理数据大小——之前只写新数据不截断，尾部残留旧格式数据（如 ASTC 6x6
        // 残留导致 10x10 导出后游戏按节点大小读到旧数据 → 资源损坏）。
        // 仅当本纹理数据延伸至节点末尾（offset+oldSize >= 节点长度，即该节点
        // 只被这一个纹理使用，本游戏 bundle 的常见形态）时才可安全截断；
        // 若节点尾部还有其他流数据（多纹理共享 resS），无法安全缩小，保持原样。
        if (offset + oldSize >= nodeData.length) {
          bundle.files[nodeIndex] = nodeData.slice(0, offset + finalEncoded.length).buffer;
        }
      }

      Object.defineProperty(tex.streamData, 'size', {
        value: finalEncoded.length,
        writable: true,
        configurable: true,
      });

      const objInfo = (tex as any).__info as ObjectInfo;
      const objBytesStart = objInfo.bytesStart;
      const objBytesSize = objInfo.bytesSize;
      const objWriter = new ArrayBufferWriter(objBytesSize);
      tex.serialize(objWriter);
      const serialized = new Uint8Array(objWriter.getBuffer().slice(0, objWriter.position));

      if (serialized.byteLength !== objBytesSize) {
        throw new Error(
          `modifyTexture2D: serialized size ${serialized.byteLength} != original ${objBytesSize}`,
        );
      }

      const assetPath = objInfo.asset.path;
      const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
      if (assetNodeIndex === -1) {
        throw new Error(`modifyTexture2D: cannot find asset file "${assetPath}" in bundle nodes`);
      }
      const assetFileData = new Uint8Array(bundle.files[assetNodeIndex]);
      assetFileData.set(serialized, objBytesStart);
    } else {
      (tex as any)._modifiedImageData = finalEncoded;

      const objInfo = (tex as any).__info as ObjectInfo;
      const objWriter = new ArrayBufferWriter(finalEncoded.length + 1024);
      tex.serialize(objWriter);
      const serialized = objWriter.getBuffer().slice(0, objWriter.position);

      objInfo._modifiedData = serialized;

      const asset = objInfo.asset;
      const rebuiltAsset = asset.rebuild();

      const assetPath = objInfo.asset.path;
      const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
      if (assetNodeIndex === -1) {
        throw new Error(`modifyTexture2D: cannot find asset file "${assetPath}" in bundle nodes`);
      }
      bundle.files[assetNodeIndex] = rebuiltAsset;
    }

    const rebuilt = bundle.rebuild(this.compressionMode);

    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);

    clearCache(fileId);
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  async modifyTextAsset(
    fileId: string,
    pathId: bigint,
    textData: string,
  ): Promise<boolean> {
    return this.applyTextAssetBytes(fileId, pathId, new TextEncoder().encode(textData), 'modifyTextAsset');
  }

  /** 通用：把 TextAsset 的 m_Script 替换为指定二进制字节并重建 bundle（KFB 回写 / 文本修改共用） */
  async applyTextAssetBytes(
    fileId: string,
    pathId: bigint,
    bytes: Uint8Array,
    from = 'applyTextAssetBytes',
  ): Promise<boolean> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`${from}: file ${fileId} not found`);

    const bundle = await loadAssetBundle(origFs.slice(0));
    const obj = bundle.objectMap.get(pathId);
    if (!obj) throw new Error(`${from}: object ${pathId} not found in bundle`);
    if (obj.type !== AssetType.TextAsset) {
      throw new Error(`${from}: object ${pathId} is not a TextAsset (type=${obj.type})`);
    }
    const textAsset = obj as TextAsset;

    (textAsset as any)._modifiedTextData = bytes;

    const objWriter = new ArrayBufferWriter(bytes.length + 1024);
    textAsset.serialize(objWriter);
    const serialized = objWriter.getBuffer().slice(0, objWriter.position);

    const objInfo = (textAsset as any).__info as ObjectInfo;
    objInfo._modifiedData = serialized;

    const asset = objInfo.asset;
    const rebuiltAsset = asset.rebuild();

    const assetPath = objInfo.asset.path;
    const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
    if (assetNodeIndex === -1) {
      throw new Error(`${from}: cannot find asset file "${assetPath}" in bundle nodes`);
    }
    bundle.files[assetNodeIndex] = rebuiltAsset;

    const rebuilt = bundle.rebuild(this.compressionMode);
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache(fileId);
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  /**
   * Modify any asset's data by providing JSON that matches the TypeTree structure.
   * This is the reverse of getTypeTree(): takes the JSON output and serializes it
   * back to binary using the asset's TypeTree nodes, then rebuilds the bundle.
   *
   * Works for ANY asset type that has TypeTree data.
   */
  async modifyAssetByJson(
    fileId: string,
    pathId: bigint,
    jsonData: Record<string, any>,
  ): Promise<boolean> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`modifyAssetByJson: file ${fileId} not found`);

    const bundle = await loadAssetBundle(origFs.slice(0));
    const obj = bundle.objectMap.get(pathId);
    if (!obj) throw new Error(`modifyAssetByJson: object ${pathId} not found in bundle`);

    const objInfo = (obj as any).__info as ObjectInfo;
    const serializedType = objInfo.serializedType;
    const typeTreeNodes = serializedType?.typeTree?.nodes;

    if (!typeTreeNodes || typeTreeNodes.length === 0) {
      throw new Error(
        `modifyAssetByJson: object ${pathId} (type=${AssetType[obj.type] ?? obj.type}) has no TypeTree data. ` +
        `Cannot serialize without TypeTree.`
      );
    }

    const littleEndian = !objInfo.asset.fileEndianness;

    // getTypeTree() returns data with the root "Base" wrapper removed:
    //   result = { "Base": { "m_Name": "...", ... } } → returns result.Base
    // serializeFromTypeTree() expects the full structure including the root key.
    // So we need to re-wrap the JSON with the root node's name if it's missing.
    const rootName = typeTreeNodes[0]?.name;
    const dataToSerialize = (rootName && !(rootName in jsonData))
      ? { [rootName]: jsonData }
      : jsonData;

    // serializeFromTypeTree handles the full binary layout including m_Name
    // (the TypeTree nodes describe the complete object from bytesStart).
    // Do NOT prepend the name separately - it's already in the TypeTree.
    const serializedData = serializeFromTypeTree(typeTreeNodes, dataToSerialize, littleEndian);

    // Set as modified data
    objInfo._modifiedData = serializedData;

    // Rebuild the asset
    const asset = objInfo.asset;
    const rebuiltAsset = asset.rebuild();

    // Find and replace the asset file in the bundle
    const assetPath = objInfo.asset.path;
    const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
    if (assetNodeIndex === -1) {
      throw new Error(`modifyAssetByJson: cannot find asset file "${assetPath}" in bundle nodes`);
    }
    bundle.files[assetNodeIndex] = rebuiltAsset;

    // Rebuild the bundle
    const rebuilt = bundle.rebuild(this.compressionMode);
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache(fileId);
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  /**
   * 修改 Sprite 的 pixelsToUnits 字段
   */
  async modifySpritePixelsToUnits(
    fileId: string,
    pathId: bigint,
    pixelsToUnits: number,
  ): Promise<boolean> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`modifySprite: file ${fileId} not found`);

    const bundle = await loadAssetBundle(origFs.slice(0));
    const obj = bundle.objectMap.get(pathId);
    if (!obj) throw new Error(`modifySprite: object ${pathId} not found in bundle`);
    if (obj.type !== AssetType.Sprite) {
      throw new Error(`modifySprite: object ${pathId} is not a Sprite (type=${obj.type})`);
    }

    const sprite = obj as Sprite;
    (sprite as any)._modifiedPixelsToUnits = pixelsToUnits;

    const objInfo = (sprite as any).__info as ObjectInfo;
    const objBytesSize = objInfo.bytesSize;
    const objWriter = new ArrayBufferWriter(objBytesSize);
    sprite.serialize(objWriter);
    const serialized = new Uint8Array(objWriter.getBuffer().slice(0, objWriter.position));

    if (serialized.byteLength !== objBytesSize) {
      throw new Error(
        `modifySprite: serialized size ${serialized.byteLength} != original ${objBytesSize}`,
      );
    }

    objInfo._modifiedData = serialized.buffer;

    const asset = objInfo.asset;
    const rebuiltAsset = asset.rebuild();

    const assetPath = objInfo.asset.path;
    const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
    if (assetNodeIndex === -1) {
      throw new Error(`modifySprite: cannot find asset file "${assetPath}" in bundle nodes`);
    }
    bundle.files[assetNodeIndex] = rebuiltAsset;

    const rebuilt = bundle.rebuild(this.compressionMode);
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache(fileId);
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  /**
   * 将 bundle 重新加密回 KH 格式。
   * 加密前先按当前压缩模式重打包内层 UnityFS，使压缩模式下拉对 KH bundle 同样生效
   * （否则游戏加载器会因内层压缩态与预期不符而报“资源损坏”）。
   *
   * 游戏完整性校验规则（字节实证，8/8 原版样本）：
   *   CRC32(解压后的 blockData) == 文件名数字
   * 原版数据天然满足；修改资源后必须补丁。补丁必须位于「节点数据流」内
   * （rebuild 以 files 拼接 blockData，节点之外的尾部补丁会被丢弃），因此
   * 追加到 resS 流节点尾部——Texture2D 按自身 streamData.offset/size 读取，
   * 流尾 4 字节不影响资产，且随 rebuild(0/3) 一同进入明文/压缩数据，
   * 解压后 CRC 校验通过。旧流程（对压缩字节尾部打补丁）解压后补丁不存在，
   * 且可能污染 LZ4 流 → 游戏判定资源损坏。
   */
  async encryptBundleToKh(fileId: string, signature?: string): Promise<ArrayBuffer | undefined> {
    const raw = this.unityFsMap.get(fileId);
    if (!raw || !isUnityFs(raw)) return undefined;
    const meta = this.khMetaMap.get(fileId);
    const fileName = this.fileNameMap.get(fileId);
    const bundle = (await loadAssetBundle(raw.slice(0))) as BundleFile;
    if (fileName) {
      this.appendCrcPatchToBundle(bundle, fileName);
    }
    const unityFs = bundle.rebuild(this.compressionMode);
    return encryptUnityFsToKh(unityFs, meta, signature, undefined);
  }

  /**
   * 若 bundle 数据的 CRC32 ≠ 文件名数字，向 resS 流节点尾部追加 4 字节补丁。
   * resS 是纹理数据流，尾部补丁不影响 Texture2D 读取（按 offset/size 截取）。
   * 返回是否追加了补丁。
   */
  private appendCrcPatchToBundle(bundle: BundleFile, fileName: string): boolean {
    const m = fileName.match(/\d+/);
    if (!m) return false;
    const targetCrc = parseInt(m[0], 10) >>> 0;

    // blockData = files 按序拼接（与 BundleFile.rebuild 一致），流式计算 CRC32
    let crc = 0xffffffff;
    for (const f of bundle.files) {
      const u = new Uint8Array(f);
      for (let i = 0; i < u.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u[i]) & 0xff];
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (crc === targetCrc) return false; // 数据未修改，天然满足

    const patch = computeCrc32Patch(crc, targetCrc);

    const idx = bundle.nodes.findIndex(n => n.path.endsWith('.resS'));
    if (idx === -1) {
      console.warn(
        `[encryptBundleToKh] bundle 无 .resS 流节点，无法安全追加 CRC 补丁（文件名 ${fileName}）`,
      );
      return false;
    }

    const old = new Uint8Array(bundle.files[idx]);
    const withPatch = new Uint8Array(old.length + 4);
    withPatch.set(old, 0);
    new DataView(withPatch.buffer).setUint32(old.length, patch, true);
    bundle.files[idx] = withPatch.buffer;
    return true;
  }

  private createObjPathGetter(groupMethod: ExportGroupMethod): ObjectPathGetter {
    switch (groupMethod) {
      case ExportGroupMethod.NONE:
        return () => '';
      case ExportGroupMethod.CONTAINER_PATH:
        return obj => obj.container;
      case ExportGroupMethod.TYPE_NAME:
        return obj => AssetType[obj.type] || '';
      case ExportGroupMethod.SOURCE_FILE_NAME:
        return (_, fileName) => fileName;
      default:
        return () => '';
    }
  }

  private createWriteFileErrorHandler() {
    const errorHandler = (e: unknown, item: AssetExportItem) => {
      if (e instanceof FsaError && e.code === FsaErrorCode.EEXIST) {
        ret.errorStat.skip++;
        console.warn(`[AssetManager] file ${item.name} already exists, skip`);
        return;
      }
      ret.errorStat.error++;
      console.error(`[AssetManager] failed to export ${item.name}`);
      console.error(e);
    };
    const ret = {
      errorStat: {
        skip: 0,
        error: 0,
      },
      errorHandler,
    };
    return ret;
  }

  // ---------- KFB 战斗逻辑（UnityKH* AssetBundle 内 TextAsset 的 AES-256-CTR + LZ4 解密 / 回加密）----------

  /**
   * 解密 KFB AssetBundle 并解析出战斗数据视图。
   * @param fileBytes 原始 .assetbundle 字节（UnityFS / UnityKHFS / UnityKHNFS / UnityKH1FS）
   * @param keyText AES-256 Key（64 位十六进制）
   * @param wanted TextAsset 名称（留空自动；多候选时需指定）
   * @returns semantic/runtime/xml 三视图 + 候选列表
   */
  async kfbDecode(
    fileBytes: Uint8Array,
    keyText: string,
    wanted?: string,
  ): Promise<{
    name: string;
    semantic: string;
    xml: string;
    runtime: string;
    candidates: string[];
  }> {
    const { decryptBundle, findCandidates } = await import('./loaders/kfbBundle');
    const { decodeKfb } = await import('./loaders/kfbCodec');
    const candidates = await findCandidates(fileBytes, keyText);
    if (candidates.length === 0) {
      throw new Error('未找到可解密 TextAsset：请检查 AES Key（64 位十六进制）或文件是否为 KFB 加密 AssetBundle');
    }
    const name =
      wanted && candidates.includes(wanted) ? wanted : candidates.length === 1 ? candidates[0] : '';
    if (!name) {
      // 多候选未指定时不抛错，返回空内容 + 候选列表，让 UI 渲染选择器
      return { name: '', semantic: '', xml: '', runtime: '', candidates };
    }
    const ext = await decryptBundle(fileBytes, keyText, name);
    const views = await decodeKfb(ext.plain);
    return { name, semantic: views.semantic, xml: views.xml, runtime: views.runtime, candidates };
  }

  /**
   * 将编辑后的 KFB 文本（semantic JSON / legacy XML / runtime JSON）回编码并回加密，输出新 .assetbundle。
   * @returns 新 assetbundle 字节（CRC 自动修复为原文件名数字）
   */
  async kfbExportEncrypted(
    originalBytes: Uint8Array,
    keyText: string,
    name: string,
    text: string,
    format: 'semantic' | 'xml' | 'runtime',
  ): Promise<Uint8Array> {
    const { encryptBundle } = await import('./loaders/kfbBundle');
    const { encodeKfb } = await import('./loaders/kfbCodec');
    const plain = await encodeKfb(text, format);
    const out = await encryptBundle(originalBytes, keyText, name, plain, { unityFs: true });
    return transfer(out, [out.buffer]);
  }

  /** 取已加载 bundle 中 TextAsset 对象的 m_Script 容器字节（KFB 加密容器） */
  private getTextAssetContainer(fileId: string, pathId: bigint): Uint8Array {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`kfb: file ${fileId} not found`);
    const bundle = this.bundleMap.get(fileId);
    if (!bundle) throw new Error(`kfb: bundle ${fileId} not loaded`);
    const obj = bundle.objectMap.get(pathId);
    if (!obj || obj.type !== AssetType.TextAsset) {
      throw new Error(`kfb: object ${pathId} is not a TextAsset`);
    }
    const data = (obj as TextAsset).data;
    return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Uint8Array);
  }

  /** 取已加载 TextAsset 的原始 m_Script 字节（protobuf 查看器用） */
  async getTextAssetRaw(fileId: string, pathId: bigint): Promise<Uint8Array> {
    const bytes = this.getTextAssetContainer(fileId, pathId);
    return transfer(bytes.slice(), [bytes.buffer]);
  }

  /**
   * 内联 KFB 解密：取已加载 TextAsset 的加密容器 → 解密 → 解析战斗数据。
   * 返回 semantic + xml（均可编辑回写，回转验证字段无损）；
   * runtime 2.9MB 视图见独立工具 KfbViewer，避免 Comlink 传输卡顿。
   */
  async kfbDecodeAsset(
    fileId: string,
    pathId: bigint,
    keyText: string,
  ): Promise<{ semantic: string; xml: string; usedKey: string }> {
    const { decryptKfbContainer, decryptKfbContainerAuto } = await import('./loaders/kfbBundle');
    const { decodeKfb } = await import('./loaders/kfbCodec');
    const container = this.getTextAssetContainer(fileId, pathId);
    let plain: Uint8Array;
    let usedKey = keyText;
    if (keyText?.trim()) {
      plain = await decryptKfbContainer(container, keyText);
    } else {
      // 留空 → 自动匹配内置 key 库（命中后缓存 fileId→key，下次打开秒开免遍历）
      const cached = this.kfbKeyCache.get(fileId);
      if (cached) {
        usedKey = cached;
        plain = await decryptKfbContainer(container, cached);
      } else {
        const { kfbKeyList } = await import('./kfb/kfbKeys');
        const hit = await decryptKfbContainerAuto(container, kfbKeyList);
        plain = hit.plain;
        usedKey = hit.key;
        this.kfbKeyCache.set(fileId, usedKey);
      }
    }
    const views = await decodeKfb(plain);
    return { semantic: views.semantic, xml: views.xml, usedKey };
  }

  /**
   * 内联 KFB 回写：编辑文本 → 回编码 → 回加密容器 → 写回 TextAsset m_Script。
   * 写回后走现有「加密导出」流程（菜单导出加密 AssetBundle）。
   */
  /**
   * 内联 KFB 回写：编辑文本 → 回编码 → 复用 encryptBundle 的 rebuildSerialized 链路写回原始 bundle。
   * 不走 @arkntools 的 asset.rebuild()（它按加载时缓存的对象大小预分配 buffer，m_Script 长度
   * 变化会写入越界抛 "RangeError: offset is out of bounds"）。encryptBundle 按新大小重排对象，已验证可正确处理变长。
   */
  async kfbApplyToAsset(
    fileId: string,
    pathId: bigint,
    keyText: string,
    text: string,
    format: 'semantic' | 'xml' | 'runtime',
  ): Promise<boolean> {
    const step = (n: string, info?: unknown) => {
      console.log(`[kfbApplyToAsset] ${n}`, info ?? '');
    };
    const fail = (n: string, e: unknown): never => {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`[kfbApplyToAsset] FAIL at ${n}:`, err.message, '\n', err.stack);
      throw err;
    };

    let pristine: Uint8Array;
    let name: string;
    let effectiveKey: string;
    let plain: Uint8Array;
    let out: Uint8Array;
    try {
      step('start', { fileId, pathId: pathId.toString(), format, textLen: text.length });
      const { decryptKfbContainerAuto, encryptBundle } = await import('./loaders/kfbBundle');
      const { encodeKfb } = await import('./loaders/kfbCodec');

      pristine = this.pristineMap.get(fileId) ?? fail('pristine-missing', new Error('找不到原始 bundle 字节（pristineMap 为空，可能 bundle 未通过 loadFile 加载）'));
      step('pristine ok', { len: pristine.length });

      // 资源名（encryptBundle 的 find() 按 TextAsset m_Name 匹配）。
      // 注意：不能取 getContainer(pathId) —— 那是容器路径（assets/.../xxx.bytes），
      // 与 m_Name（90382_p）不一致会导致 find() 匹配不到；须用对象的 name（= m_Name）。
      const assetObj = this.getAssetObj(fileId, pathId);
      name = assetObj?.name ?? '';
      if (!name) fail('name-missing', new Error('找不到资源名，无法定位 TextAsset'));
      step('name ok', { name });

      // 解析实际使用的 key（留空 → 自动匹配内置 key 库，回写用同一 key）
      effectiveKey = keyText;
      if (!keyText?.trim()) {
        const container = this.getTextAssetContainer(fileId, pathId);
        step('auto-key: container ok', { len: container.length });
        const cached = this.kfbKeyCache.get(fileId);
        if (cached) {
          effectiveKey = cached;
          step('auto-key cached', { key: cached.slice(0, 12) + '...' });
        } else {
          const { kfbKeyList } = await import('./kfb/kfbKeys');
          try {
            const hit = await decryptKfbContainerAuto(container, kfbKeyList);
            effectiveKey = hit.key;
            this.kfbKeyCache.set(fileId, effectiveKey);
            step('auto-key matched', { key: hit.key.slice(0, 12) + '...' });
          } catch (e) {
            fail('auto-key', e);
          }
        }
      } else {
        step('use user key', { key: keyText.slice(0, 12) + '...' });
      }

      try {
        plain = await encodeKfb(text, format);
        step('encode ok', { plainLen: plain.length });
      } catch (e) {
        throw fail('encodeKfb', e);
      }

      // 始终基于 pristine 字节写回，避免反复 apply 叠加 @arkntools 重建产物
      try {
        out = await encryptBundle(pristine, effectiveKey, name, plain, { unityFs: true });
        step('encryptBundle ok', { outLen: out.length, delta: out.length - pristine.length });
      } catch (e) {
        throw fail('encryptBundle', e);
      }

      try {
        this.unityFsMap.set(fileId, out.buffer as ArrayBuffer);
        this.bundleMap.delete(fileId);
        this.bundleMap.set(fileId, await loadAssetBundle(out.slice(0)));
        clearCache(fileId);
        this.modifiedAssets.add(`${fileId}_${pathId}`);
        step('reload ok');
        return true;
      } catch (e) {
        fail('reload-loadAssetBundle', e);
      }
      return false;
    } catch (e) {
      // 顶层兜底：保证 UI 至少能看到 step 信息
      console.error('[kfbApplyToAsset] 顶层捕获:', e);
      throw e;
    }
  }
}

expose({ AssetManager });
