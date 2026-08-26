import type { AssetFileLoadOptions, TextureFormat } from '@arkntools/unity-js';
import { proxy, transfer, wrap } from 'comlink';
import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { RepoDataHandler } from '@/types/repository';
import { showBatchFilesResultMessage, showNotingCanBeExportToast } from '@/utils/toasts';
import type { BatchFilesResult } from '@/utils/toasts';
import { buildZipStore, type ZipEntry } from '@/utils/zipStore';
import { expandArchives } from '@/utils/archive';
import type { AssetInfo, ExportAssetsOnProgress, FileLoadingOnProgress } from '@/workers/assetManager';
import AssetManagerWorker from '@/workers/assetManager/index.js?worker';
import { decodeAudioFileToPcm } from '@/utils/audioDecode';
import { useProgress } from './progress';
import { useRepository } from './repository';
import { useSetting } from './setting';

const { AssetManager } = wrap<typeof import('@/workers/assetManager')>(new AssetManagerWorker());

const manager = new AssetManager();

const pickExportDir = () => window.showDirectoryPicker({ id: 'export-assets', mode: 'readwrite' }).catch(console.error);

const showExportResultMessage = (result?: BatchFilesResult) => {
  showBatchFilesResultMessage('Exported', result);
};

/**
 * Build a download name by inserting a suffix before the extension.
 * e.g. ("foo.assetbundle", "decrypted") -> "foo_decrypted.assetbundle";
 *      ("foo", "encrypted") -> "foo_encrypted".
 * Splits on the LAST dot so multi-dot names like "a.b.bundle" keep their full ext.
 */
const buildExportName = (fileName: string, suffix: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_${suffix}${fileName.slice(dot)}` : `${fileName}_${suffix}`;
};

/** Trigger a browser download of an ArrayBuffer/Uint8Array with the given file name. */
const downloadArrayBuffer = (buffer: ArrayBuffer | Uint8Array, downloadName: string) => {
  const blob = new Blob([buffer as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/** Local timestamp like "2026-07-21_143408" for archive file names. */
const formatTimestamp = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(
    d.getSeconds(),
  )}`;
};

/** Build zip entries from {fileName,data} pairs, de-duplicating names inside the zip. */
const toUniqueZipEntries = (items: { fileName: string; data: Uint8Array }[]): ZipEntry[] => {
  const used = new Set<string>();
  return items.map(({ fileName, data }) => {
    let name = fileName;
    if (used.has(name)) {
      const dot = fileName.lastIndexOf('.');
      const base = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      let i = 2;
      while (used.has(`${base}_${i}${ext}`)) i++;
      name = `${base}_${i}${ext}`;
    }
    used.add(name);
    return { name, data };
  });
};

export const useAssetManager = defineStore('assetManager', () => {
  const progressStore = useProgress();
  const setting = useSetting();
  const repository = useRepository();

  const assetInfos = shallowRef<AssetInfo[]>([]);
  const curAssetInfo = shallowRef<AssetInfo>();
  const isLoading = ref(false);
  const previewVersion = ref(0);
  const pendingEditTab = ref(false);

  const assetInfoMap = computed(() => new Map(assetInfos.value.map(info => [info.key, info])));

  AssetManager.setFsbConverter(
    proxy(async (params, isPreview) => {
      const { convertFsb, FsbConvertFormat } = await import('@arkntools/unity-js/audio');
      const data = await convertFsb(
        params,
        isPreview ? FsbConvertFormat.WAV : setting.data.fsbConvertFormat,
        isPreview ? undefined : { vbrQuality: setting.data.fsbConvertVbrQuality as any },
      );
      return transfer(data, [data.buffer]);
    }),
  );

  // 独立 FSB bank 子音频解码器（主线程 FMOD WASM，经 Comlink 回传 worker 调用）
  AssetManager.setFsbSubConverter(
    proxy(async (data: Uint8Array, size: number, channels: number, index: number, sampleRate?: number) => {
      const { decodeFsbSubSound } = await import('@/utils/fsbDecode');
      const wav = await decodeFsbSubSound(data, size, channels, index, sampleRate);
      return transfer(wav as Uint8Array<ArrayBuffer>, [wav.buffer as ArrayBuffer]);
    }),
  );

  watch(
    () => setting.data.fsbConvertFormat,
    () => {
      AssetManager.setFsbConvertFormat(setting.data.fsbConvertFormat);
    },
    { immediate: true },
  );

  const canExport = ({ canExport }: AssetInfo) => canExport;

  const onProgress = proxy<FileLoadingOnProgress>(({ name, progress, totalAssetNum }) => {
    progressStore.setProgress({
      type: 'loading',
      value: progress,
      desc: `Loading ${name}, total assets: ${totalAssetNum}`,
    });
  });

  const loadFiles = async (files: File[], loadOptions?: AssetFileLoadOptions) => {
    if (isLoading.value) return;
    isLoading.value = true;
    curAssetInfo.value = undefined;
    try {
      // 自动解压：遇到 .zip 先展开成内部文件，等价于直接拖入解压后的文件
      const expanded = await expandArchives(files);
      const { errors, infos, successNum } = await (
        await manager
      ).loadFiles(
        expanded,
        {
          unityCNKey: setting.unityCNKey,
          env: setting.data.unityEnv,
          ...loadOptions,
        },
        onProgress,
      );
      assetInfos.value = infos;
      // 导入含 FSB bank 时，自动选中 FSB Bank 资产直接进编辑器，
      // 否则它会淹没在几十个子音频资产里，用户找不到「替换/导出 bank」入口
      const bankInfo = infos.find(i => i.type === 'FsbBank');
      if (bankInfo) curAssetInfo.value = bankInfo;
      if (!infos.length) {
        const hasZip = files.some((f) => /\.zip$/i.test(f.name));
        ElMessage({
          message: hasZip
            ? `未从压缩包中解析到任何可加载资产（已尝试自动解压 ${files.length} 个压缩包）`
            : `未从 ${files.length} 个文件中加载到任何资产`,
          type: 'warning',
        });
      } else if (expanded.length === 1 && errors.length) {
        errors.forEach(({ name, error }) => {
          const msg = String(error);
          let displayMsg: string;
          if (msg.includes('Unsupported bundle')) {
            displayMsg = `加载失败：不支持的加密格式 (${name})`;
          } else if (msg.includes('decrypt') || msg.includes('Decrypt')) {
            displayMsg = `解密失败：密钥不匹配或文件损坏 (${name})`;
          } else {
            displayMsg = `加载失败 (${name}): ${error}`;
          }
          ElMessage({ message: displayMsg, type: 'error' });
        });
      } else {
        ElMessage({
          message: `已加载 ${infos.length} 个资产，来自 ${successNum} 个文件`,
          type: 'success',
        });
      }
    } catch (error) {
      ElMessage({
        message: `Failed to load: ${error}`,
        type: 'error',
      });
    } finally {
      isLoading.value = false;
      progressStore.clearProgress();
    }
  };

  const clearFiles = async () => {
    assetInfos.value = [];
    clearPreviewCache();
    await (await manager).clear();
  };

  /**
   * 静默加载单个 bundle（批量工作流专用）
   * - 不检查 isLoading，不弹 toast，不设 isLoading 状态
   * - 加载前自动 clear 释放上一个 bundle 的内存
   * - 返回该 bundle 的 AssetInfo 列表
   *
   * 注意：comlink 通过 postMessage 传参，不能传函数（会触发 DataCloneError）。
   * 因此不能传 onProgress 回调，worker 端 loadFiles 的 onProgress 已改为可选。
   * 同时需用 markRaw 包装 file 和 opts，避免 Vue 响应式代理干扰 structuredClone。
   */
  const loadSingleBundleSilently = async (file: File): Promise<AssetInfo[]> => {
    // 先清空 worker 内存，避免累积
    assetInfos.value = [];
    clearPreviewCache();
    await (await manager).clear();
    // 强制取原始值：setting.unityCNKey 是 computed，setting.data 是 ref，
    // Pinia 访问时会自动解包；但为防止边界情况，用 typeof 兜底过滤
    const unityCNKeyRaw = setting.unityCNKey;
    const unityEnvRaw = setting.data.unityEnv;
    const opts: AssetFileLoadOptions = {
      unityCNKey: typeof unityCNKeyRaw === 'string' ? unityCNKeyRaw : undefined,
      env: typeof unityEnvRaw === 'number' ? unityEnvRaw : 0,
    };
    // markRaw 防止 opts/file 被响应式追踪，确保 comlink structuredClone 拿到原始对象
    const result = await (await manager).loadFiles(markRaw([file]), markRaw(opts));
    assetInfos.value = result.infos;
    return result.infos;
  };

  /**
   * 辅助加载：将 bundle 加入 worker 会话（bundleMap），但不替换 assetInfos / curAssetInfo。
   * 用于 KFB 编辑器侧载帧动画 bundle —— worker 的 getSessionSprites() 会自动聚合所有已加载 bundle 的 Sprite。
   * 返回新加载的 AssetInfo[]，调用方可从中筛选 PreviewType.FrameAnimation 资产。
   */
  const loadBundlesAux = async (files: File[]): Promise<AssetInfo[]> => {
    const expanded = await expandArchives(files);
    const opts: AssetFileLoadOptions = {
      unityCNKey: setting.unityCNKey,
      env: setting.data.unityEnv,
    };
    const { infos } = await (await manager).loadFiles(markRaw(expanded), markRaw(opts));
    return infos;
  };

  const getDataHandler = async (info: AssetInfo) => {
    const { dataHandler } = repository;
    try {
      if (dataHandler && (await dataHandler.needHandle(info))) {
        return proxy<RepoDataHandler>(data => dataHandler.handler(info, data));
      }
    } catch (e) {
      console.error(e);
    }
  };

  /**
   * 预览数据缓存：避免反复切换资产时重复走 worker 解码、以及大数据 URL 经 postMessage 回传的延迟。
   * 命中缓存时来回切换同一资产可即时呈现，消除"卡卡的、不及时的"观感。
   * - previewVersion 计入缓存 key：纹理编辑保存后缓存自动失效，确保看到最新结果。
   * - LRU 上限 16，超出淘汰最早条目，避免大图 data URL 无限占用内存。
   */
  const previewCache = new Map<string, string | null>();
  const PREVIEW_CACHE_MAX = 16;
  const clearPreviewCache = () => previewCache.clear();

  const loadPreviewData = async (info: AssetInfo, payload?: any) => {
    const cacheKey = `${info.fileId}:${info.pathId}:${payload ?? ''}:${previewVersion.value}`;
    const cached = previewCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const handler = await getDataHandler(info);
    const data = await (await manager).getPreviewData(info.fileId, info.pathId, payload, handler);
    const result = data ?? null;
    if (previewCache.size >= PREVIEW_CACHE_MAX) {
      const oldest = previewCache.keys().next().value;
      if (oldest !== undefined) previewCache.delete(oldest);
    }
    previewCache.set(cacheKey, result);
    return result;
  };

  const setCurAssetInfo = (info: AssetInfo) => {
    curAssetInfo.value = info;
  };

  const exportAsset = async (info: AssetInfo) => {
    const { fileId, pathId, canExport } = info;
    if (!canExport) {
      showNotingCanBeExportToast();
      return;
    }
    const handle = await pickExportDir();
    if (!handle) return;
    showExportResultMessage(await (await manager).exportAsset(handle, fileId, pathId, await getDataHandler(info)));
  };

  /**
   * 导出单个资产到指定目录（批量工作流调用，不弹选目录对话框）
   * 直接复用 worker.exportAsset，文件名由 worker 内部按纹理名生成
   * @param customName 可选自定义文件名（不含扩展名），用于批量工作流按尺寸区分同名纹理
   */
  const exportTextureToDir = async (
    fileId: string,
    pathId: bigint,
    dirHandle: FileSystemDirectoryHandle,
    customName?: string,
  ) => {
    return (await manager).exportAsset(dirHandle, fileId, pathId, undefined, customName);
  };

  const isBatchExporting = ref(false);

  const batchExportOnProgress = proxy<ExportAssetsOnProgress>(({ progress, name }) => {
    progressStore.setProgress({
      value: progress * 100,
      desc: `Exporting ${name}`,
    });
  });

  const batchExportAsset = async (infos: AssetInfo[]) => {
    if (isBatchExporting.value) return;
    isBatchExporting.value = true;
    try {
      const handle = await pickExportDir();
      if (!handle) return;
      progressStore.setProgress({
        type: 'exporting',
        desc: 'Exporting',
      });
      const dataHandlers = await Promise.all(infos.map(info => getDataHandler(info)));
      showExportResultMessage(
        await (
          await manager
        ).exportAssets(
          handle,
          infos.map(({ fileId, pathId, fileName }, i) => ({
            fileId,
            pathId,
            fileName,
            hasDataHandler: Boolean(dataHandlers[i]),
          })),
          { groupMethod: setting.data.exportGroupMethod },
          batchExportOnProgress,
          proxy((data, i) => dataHandlers[i]!(data)),
        ),
      );
      progressStore.setProgress({
        value: 100,
        desc: '',
      });
    } catch (error) {
      console.error(error);
    } finally {
      isBatchExporting.value = false;
      progressStore.clearProgress();
    }
  };

  const exportAllAssets = async () => {
    const canExportAssets = assetInfos.value.filter(canExport);
    if (!canExportAssets.length) {
      showNotingCanBeExportToast();
      return;
    }
    await batchExportAsset(assetInfos.value);
  };

  const getAssetInfoByPathId = (pathId: bigint | string) => {
    if (typeof pathId !== 'bigint') {
      try {
        pathId = BigInt(pathId);
      } catch {
        return;
      }
    }
    const info = assetInfos.value.find(info => info.pathId === pathId);
    return info;
  };

  const getDecryptedBundle = async (fileId: string) => {
    return (await manager).getUnityFs(fileId);
  };

  const exportDecryptedBundle = async (info: AssetInfo) => {
    const buffer = await getDecryptedBundle(info.fileId);
    if (buffer) {
      downloadArrayBuffer(buffer, buildExportName(info.fileName, 'decrypted'));
    } else {
      ElMessage({ message: '解密导出失败：文件数据不可用', type: 'error' });
    }
  };

  const exportAllDecryptedBundles = async () => {
    const fileIds = new Set(assetInfos.value.map(info => info.fileId));
    const items: { fileName: string; data: Uint8Array }[] = [];
    let errorCount = 0;
    for (const fileId of fileIds) {
      const buffer = await getDecryptedBundle(fileId);
      if (!buffer) { errorCount++; continue; }
      const info = assetInfos.value.find(i => i.fileId === fileId);
      if (!info) { errorCount++; continue; }
      items.push({ fileName: info.fileName, data: new Uint8Array(buffer) });
    }
    if (!items.length && errorCount > 0) {
      ElMessage({ message: '批量解密失败：所有文件均无法解密', type: 'error' });
      return;
    }
    if (!items.length) return;
    if (errorCount > 0) {
      ElMessage({ message: `批量解密完成，${errorCount} 个文件解密失败`, type: 'warning' });
    }
    downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `decrypted_${formatTimestamp()}.zip`);
  };

  /**
   * 解密并解压导出：KH 解密 + LZ4/LZ4HC 解压，输出未压缩 UnityFS（compression=0）。
   * 与 exportDecryptedBundle 的区别：前者只去 KH 加密层，本方法进一步解压 block 数据，
   * 输出与标准解包工具一致的未压缩文件，便于 UABE 等工具直接编辑。
   */
  const exportDecompressedBundle = async (info: AssetInfo) => {
    try {
      const buffer = await (await manager).getDecompressedUnityFs(info.fileId);
      if (buffer) {
        downloadArrayBuffer(buffer, buildExportName(info.fileName, 'decompressed'));
      } else {
        ElMessage({ message: '解密解压导出失败：文件数据不可用', type: 'error' });
      }
    } catch (error) {
      ElMessage({ message: `解密解压导出失败：${error}`, type: 'error' });
    }
  };

  const exportAllDecompressedBundles = async () => {
    const fileIds = new Set(assetInfos.value.map(info => info.fileId));
    const items: { fileName: string; data: Uint8Array }[] = [];
    let errorCount = 0;
    for (const fileId of fileIds) {
      try {
        const buffer = await (await manager).getDecompressedUnityFs(fileId);
        if (!buffer) { errorCount++; continue; }
        const info = assetInfos.value.find(i => i.fileId === fileId);
        if (!info) { errorCount++; continue; }
        items.push({ fileName: info.fileName, data: new Uint8Array(buffer) });
      } catch {
        errorCount++;
      }
    }
    if (!items.length && errorCount > 0) {
      ElMessage({ message: '批量解密解压失败：所有文件均无法处理', type: 'error' });
      return;
    }
    if (!items.length) return;
    if (errorCount > 0) {
      ElMessage({ message: `批量解密解压完成，${errorCount} 个文件失败`, type: 'warning' });
    }
    downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `decompressed_${formatTimestamp()}.zip`);
  };

  const exportEncryptedBundle = async (info: AssetInfo) => {
    try {
      const buffer = await (await manager).encryptBundleToKh(info.fileId, khFormat.value);
      if (buffer) {
        downloadArrayBuffer(buffer, buildExportName(info.fileName, 'encrypted'));
      } else {
        ElMessage({ message: '加密失败：文件数据不可用或不是 UnityFS 格式', type: 'error' });
      }
    } catch (error) {
      ElMessage({ message: `加密导出失败：${error}`, type: 'error' });
    }
  };

  const exportAllEncryptedBundles = async () => {
    try {
      const fileIds = new Set(assetInfos.value.map(info => info.fileId));
      const items: { fileName: string; data: Uint8Array }[] = [];
      let errorCount = 0;
      for (const fileId of fileIds) {
        const buffer = await (await manager).encryptBundleToKh(fileId, khFormat.value);
        if (!buffer) { errorCount++; continue; }
        const info = assetInfos.value.find(i => i.fileId === fileId);
        if (!info) { errorCount++; continue; }
        items.push({ fileName: info.fileName, data: new Uint8Array(buffer) });
      }
      if (!items.length && errorCount > 0) {
        ElMessage({ message: '批量加密失败：所有文件均无法加密', type: 'error' });
        return;
      }
      if (!items.length) return;
      if (errorCount > 0) {
        ElMessage({ message: `批量加密完成，${errorCount} 个文件加密失败`, type: 'warning' });
      }
      downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `encrypted_${formatTimestamp()}.zip`);
    } catch (error) {
      ElMessage({ message: `批量加密导出失败：${error}`, type: 'error' });
    }
  };

  const hasKhBundles = ref(false);
  const khBundleFileIds = ref<Set<string>>(new Set());
  const khFormat = ref<string>('UnityKHFS');
  /** 写回 bundle 压缩模式：0=NONE(默认,不压缩) | 2=LZ4 | 3=LZ4_HC(游戏兼容) */
  const compressionMode = ref<number>(0);
  /** 批量换图 / 纹理写回的锐化档位：0=不锐化，1-3=SHARPEN_PRESETS 档位（批量工作流 UI 使用） */
  const sharpen = ref<number>(0);

  /** Track which fileIds have been modified (e.g., via Edit tab texture changes) */
  const modifiedFileIds = ref<Set<string>>(new Set());

  const checkKhBundles = async () => {
    const fileIds = new Set(assetInfos.value.map(info => info.fileId));
    const set = new Set<string>();
    for (const fileId of fileIds) {
      if (await (await manager).isKhBundle(fileId)) {
        set.add(fileId);
      }
    }
    khBundleFileIds.value = set;
    hasKhBundles.value = set.size > 0;
  };

  watch(assetInfos, checkKhBundles, { immediate: true });

  /**
   * Export bundles (encrypted or decrypted) for the given file IDs,
   * downloaded as a single zip archive.
   */
  const exportBundlesByFileIds = async (fileIds: Iterable<string>, mode: 'encrypted' | 'decrypted') => {
    const items: { fileName: string; data: Uint8Array }[] = [];
    let errorCount = 0;
    for (const fileId of fileIds) {
      const buffer = mode === 'encrypted'
        ? await (await manager).encryptBundleToKh(fileId, khFormat.value)
        : await (await manager).getUnityFs(fileId);
      if (!buffer) { errorCount++; continue; }
      const info = assetInfos.value.find(i => i.fileId === fileId);
      if (!info) { errorCount++; continue; }
      items.push({ fileName: info.fileName, data: new Uint8Array(buffer) });
    }
    if (!items.length) {
      if (errorCount > 0) {
        ElMessage({ message: mode === 'encrypted' ? '批量加密失败：所有文件均无法加密' : '批量解密失败：所有文件均无法解密', type: 'error' });
      }
      return;
    }
    if (errorCount > 0) {
      ElMessage({ message: `处理完成，${errorCount} 个文件失败`, type: 'warning' });
    }
    downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `${mode}_${formatTimestamp()}.zip`);
  };

  /**
   * 设置写回 bundle 的压缩模式并同步到 worker。
   * 3=LZ4_HC(默认,该游戏加载器只认 LZ4_HC) | 2=LZ4 | 0=NONE
   */
  const setCompressionMode = async (mode: number) => {
    compressionMode.value = mode;
    await (await manager).setCompressionMode(mode);
  };

  /**
   * 将 bundle 恢复到最初加载时的原始字节（撤销所有修改）。
   * 批量工作流专用：跨文件夹同内容 bundle 共享 fileId，每个任务导出前恢复，保证各任务输出独立。
   */
  const restoreBundle = async (fileId: string): Promise<boolean> => {
    const ok = await (await manager).restoreBundle(fileId);
    if (ok) {
      modifiedFileIds.value.delete(fileId);
      previewVersion.value++;
    }
    return ok;
  };

  /**
   * Modify a Texture2D's pixel data. Transfers the RGBA buffer to the worker
   * to avoid copying. After success, subsequent previews/exports will reflect
   * the modified texture.
   */
  const modifyTexture2D = async (
    fileId: string,
    pathId: bigint,
    rgbaData: Uint8Array<ArrayBuffer>,
    width: number,
    height: number,
    targetFormat?: TextureFormat,
    generateMips?: boolean,
    sharpenLevel = 0,
  ): Promise<boolean> => {
    try {
      const result = await (await manager).modifyTexture2D(
        fileId,
        pathId,
        transfer(rgbaData.buffer as ArrayBuffer, [rgbaData.buffer]),
        width,
        height,
        targetFormat,
        generateMips,
        sharpenLevel,
      );
      if (result) {
        previewVersion.value++;
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: '纹理修改成功', type: 'success' });
      }
      return result;
    } catch (error) {
      ElMessage({ message: `纹理修改失败：${error}`, type: 'error' });
      return false;
    }
  };

  const modifyTextAsset = async (
    fileId: string,
    pathId: bigint,
    textData: string,
  ): Promise<boolean> => {
    try {
      const result = await (await manager).modifyTextAsset(fileId, pathId, textData);
      if (result) {
        previewVersion.value++;
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: '文本修改成功', type: 'success' });
      }
      return result;
    } catch (error) {
      ElMessage({ message: `文本修改失败：${error}`, type: 'error' });
      return false;
    }
  };

  const modifySpritePixelsToUnits = async (
    fileId: string,
    pathId: bigint,
    pixelsToUnits: number,
  ): Promise<boolean> => {
    try {
      const result = await (await manager).modifySpritePixelsToUnits(fileId, pathId, pixelsToUnits);
      if (result) {
        previewVersion.value++;
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: 'Sprite PixelsToUnits 修改成功', type: 'success' });
      }
      return result;
    } catch (error) {
      ElMessage({ message: `Sprite 修改失败：${error}`, type: 'error' });
      return false;
    }
  };

  /**
   * Modify any asset's data by providing JSON that matches its TypeTree structure.
   * Works for ANY asset type that has TypeTree data (MonoBehaviour, Material, etc.)
   * The JSON structure must match the output of AssetBase.getTypeTree().
   */
  const modifyAssetByJson = async (
    fileId: string,
    pathId: bigint,
    jsonData: Record<string, any>,
  ): Promise<boolean> => {
    try {
      const result = await (await manager).modifyAssetByJson(fileId, pathId, jsonData);
      if (result) {
        previewVersion.value++;
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: '资产数据修改成功', type: 'success' });
      }
      return result;
    } catch (error) {
      ElMessage({ message: `资产数据修改失败：${error}`, type: 'error' });
      return false;
    }
  };

  const getModifiedBundle = async (fileId: string) => {
    return (await manager).getUnityFs(fileId);
  };

  /**
   * 将修改后的 bundle 加密成 KH 格式（用于批量工作流输出到同目录）
   * 与 exportModifiedBundle 逻辑一致：KH bundle → 重新加密，非 KH → 返回原始 UnityFS
   */
  const getModifiedBundleEncrypted = async (fileId: string): Promise<ArrayBuffer | undefined> => {
    const isKh = await (await manager).isKhBundle(fileId);
    if (isKh) {
      return (await manager).encryptBundleToKh(fileId, khFormat.value);
    }
    return (await manager).getUnityFs(fileId);
  };

  /**
   * Export a modified bundle preserving its original format:
   * - If the source was a KH-encrypted bundle (UnityKHFS/UnityKHNFS/UnityKH1FS),
   *   re-encrypt using the original meta (header, flags, signature) so the
   *   output is byte-compatible with the game's expected format.
   * - Otherwise export as plain UnityFS.
   */
  const exportModifiedBundle = async (info: AssetInfo) => {
    try {
      const isKh = await (await manager).isKhBundle(info.fileId);
      const buffer = isKh
        ? await (await manager).encryptBundleToKh(info.fileId, khFormat.value)
        : await getModifiedBundle(info.fileId);
      if (buffer) {
        downloadArrayBuffer(buffer, buildExportName(info.fileName, 'modified'));
      } else {
        ElMessage({ message: '导出修改后的文件失败：文件数据不可用', type: 'error' });
      }
    } catch (error) {
      ElMessage({ message: `导出修改后的文件失败：${error}`, type: 'error' });
    }
  };

  /**
   * 导出选中资产的内容为单个 ZIP（浏览器下载，无需目录选择器，Web/PWA 端可用）。
   * 与 batchExportAsset（走 showDirectoryPicker，仅桌面端）互补：
   * 这里把每个可导出资产的字节内容用 buildZipStore 打包后直接触发下载。
   */
  const exportAssetsAsZip = async (infos: AssetInfo[]) => {
    const canExportRows = infos.filter(canExport);
    if (!canExportRows.length) {
      showNotingCanBeExportToast();
      return;
    }
    isBatchExporting.value = true;
    try {
      const items: { fileName: string; data: Uint8Array }[] = [];
      let errorCount = 0;
      progressStore.setProgress({ type: 'exporting', desc: '正在打包选中资产' });
      const exportedEncrypted = new Set<string>();
      for (const info of canExportRows) {
        // 已加密的 KH bundle：导出原加密整文件（一次即可，避免多选时重复）
        if (await (await manager).isKhBundle(info.fileId)) {
          if (exportedEncrypted.has(info.fileId)) continue;
          exportedEncrypted.add(info.fileId);
          const enc = await (await manager).getEncryptedBundleData(info.fileId);
          if (enc) items.push({ fileName: enc.name, data: enc.data });
          continue;
        }
        const data = await (await manager).getAssetExportData(info.fileId, info.pathId, await getDataHandler(info));
        if (!data?.length) {
          errorCount++;
          continue;
        }
        for (const { name, data: bytes } of data) items.push({ fileName: name, data: bytes });
      }
      if (!items.length) {
        if (errorCount > 0) {
          ElMessage({ message: '打包失败：选中的资产均无法导出', type: 'error' });
        }
        return;
      }
      if (errorCount > 0) {
        ElMessage({ message: `已打包 ${items.length} 个文件，${errorCount} 个导出失败`, type: 'warning' });
      }
      downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `assets_${formatTimestamp()}.zip`);
    } catch (error) {
      console.error(error);
      ElMessage({ message: `打包导出失败：${error}`, type: 'error' });
    } finally {
      isBatchExporting.value = false;
      progressStore.clearProgress();
    }
  };

  const exportAllModifiedBundles = async () => {
    const fileIds = modifiedFileIds.value.size
      ? modifiedFileIds.value
      : new Set(assetInfos.value.map(info => info.fileId));
    const items: { fileName: string; data: Uint8Array }[] = [];
    let errorCount = 0;
    for (const fileId of fileIds) {
      try {
        const isKh = await (await manager).isKhBundle(fileId);
        const buffer = isKh
          ? await (await manager).encryptBundleToKh(fileId, khFormat.value)
          : await getModifiedBundle(fileId);
        if (!buffer) { errorCount++; continue; }
        const info = assetInfos.value.find(i => i.fileId === fileId);
        if (!info) { errorCount++; continue; }
        items.push({ fileName: info.fileName, data: new Uint8Array(buffer) });
      } catch {
        errorCount++;
      }
    }
    if (!items.length && errorCount > 0) {
      ElMessage({ message: '批量导出失败：所有文件均无法导出', type: 'error' });
      return;
    }
    if (!items.length) return;
    if (errorCount > 0) {
      ElMessage({ message: `批量导出完成，${errorCount} 个文件导出失败`, type: 'warning' });
    }
    downloadArrayBuffer(buildZipStore(toUniqueZipEntries(items)), `modified_${formatTimestamp()}.zip`);
  };

  /** FSB bank：用用户上传的音频替换某个子音频（主线程解码为 PCM16 后交给 worker 记录） */
  const replaceFsbSample = async (
    fileId: string,
    index: number,
    pcm: Int16Array,
    channels: number,
    sampleRate: number,
  ): Promise<boolean> => {
    try {
      // 传副本给 worker（Comlink 会自动 transfer 其底层 buffer）；原件留在主线程供预览试听
      const copy = pcm.slice();
      await (await manager).setFsbSampleReplacement(fileId, index, copy, channels, sampleRate);
      ElMessage({ message: `已替换样本 #${index}`, type: 'success' });
      return true;
    } catch (e) {
      ElMessage({ message: `替换失败：${e}`, type: 'error' });
      return false;
    }
  };

  /** FSB bank：重打包并导出（.bank 写回容器，裸 FSB5 导出 FSB5） */
  const exportFsbBank = async (info: AssetInfo) => {
    try {
      const result = await (await manager).exportFsbBank(info.fileId);
      if (result) {
        downloadArrayBuffer(result.data, result.name);
      } else {
        ElMessage({ message: '导出失败：bank 数据不可用', type: 'error' });
      }
    } catch (e) {
      ElMessage({ message: `导出 bank 失败：${e}`, type: 'error' });
    }
  };

  // ---------- KFB 战斗逻辑 ----------

  /** KFB：解密 AssetBundle 并解析战斗数据（semantic/xml/runtime 三视图） */
  const kfbDecode = async (
    bytes: Uint8Array,
    keyText: string,
    wanted?: string,
  ): Promise<{
    name: string;
    semantic: string;
    xml: string;
    runtime: string;
    candidates: string[];
  }> => {
    // Comlink 传输大字节数组：transfer buffer
    const transferable = bytes.slice().buffer as ArrayBuffer;
    return (await manager).kfbDecode(transfer(bytes, [transferable]) as any, keyText, wanted);
  };

  /** KFB：编辑后的文本回编码 + 回加密，返回新 .assetbundle 字节 */
  const kfbExportEncrypted = async (
    originalBytes: Uint8Array,
    keyText: string,
    name: string,
    text: string,
    format: 'semantic' | 'xml' | 'runtime',
  ): Promise<Uint8Array> => {
    const transferable = originalBytes.slice().buffer as ArrayBuffer;
    return (await manager).kfbExportEncrypted(transfer(originalBytes, [transferable]) as any, keyText, name, text, format);
  };

  /** KFB 内联：解密当前 TextAsset（返回 semantic + xml） */
  const kfbDecodeAsset = async (
    fileId: string,
    pathId: bigint,
    keyText: string,
  ): Promise<{ semantic: string; xml: string; usedKey: string }> => {
    return (await manager).kfbDecodeAsset(fileId, pathId, keyText);
  };

  /** 取当前 TextAsset 的原始 m_Script 字节（protobuf 查看器用） */
  const getTextAssetRaw = async (fileId: string, pathId: bigint): Promise<Uint8Array> => {
    return (await manager).getTextAssetRaw(fileId, pathId);
  };

  /** 通用：把 TextAsset 的 m_Script 回写为指定二进制字节并重建 bundle（protobuf 编辑回写用） */
  const applyTextAssetBytes = async (fileId: string, pathId: bigint, bytes: Uint8Array): Promise<boolean> => {
    try {
      const result = await (await manager).applyTextAssetBytes(fileId, pathId, bytes);
      if (result) {
        previewVersion.value++;
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: '回写成功（已重建 bundle）', type: 'success' });
      }
      return result;
    } catch (error) {
      ElMessage({ message: `回写失败：${error}`, type: 'error' });
      return false;
    }
  };

  /** KFB 内联：编辑文本回写当前 TextAsset（走加密导出流程） */
  const kfbApplyToAsset = async (
    fileId: string,
    pathId: bigint,
    keyText: string,
    text: string,
    format: 'semantic' | 'xml' | 'runtime',
  ): Promise<boolean> => {
    try {
      const ok = await (await manager).kfbApplyToAsset(fileId, pathId, keyText, text, format);
      if (ok) {
        modifiedFileIds.value.add(fileId);
        ElMessage({ message: 'KFB 战斗数据已写回，可到菜单「导出加密 AssetBundle」下载', type: 'success' });
      }
      return ok;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error('[kfbApplyToAsset] store 捕获:', err.message, '\n', err.stack);
      ElMessage({
        message: `KFB 写回失败：${err.message}\n(完整堆栈已打印到 F12 控制台，请截图给开发者)`,
        type: 'error',
        duration: 10000,
      });
      return false;
    }
  };

  return {
    assetInfos,
    assetInfoMap,
    curAssetInfo,
    isLoading,
    isBatchExporting,
    loadFiles,
    clearFiles,
    loadPreviewData,
    setCurAssetInfo,
    exportAsset,
    batchExportAsset,
    exportAllAssets,
    canExport,
    getAssetInfoByPathId,
    exportDecryptedBundle,
    exportAllDecryptedBundles,
    exportDecompressedBundle,
    exportAllDecompressedBundles,
    exportEncryptedBundle,
    exportAllEncryptedBundles,
    exportBundlesByFileIds,
    hasKhBundles,
    khBundleFileIds,
    khFormat,
    compressionMode,
    sharpen,
    setCompressionMode,
    modifyTexture2D,
    modifyTextAsset,
    restoreBundle,
    modifySpritePixelsToUnits,
    modifyAssetByJson,
    getModifiedBundle,
    getModifiedBundleEncrypted,
    exportTextureToDir,
    loadSingleBundleSilently,
    loadBundlesAux,
    previewVersion,
    pendingEditTab,
    modifiedFileIds,
    exportModifiedBundle,
    exportAllModifiedBundles,
    exportAssetsAsZip,
    replaceFsbSample,
    exportFsbBank,
    kfbDecode,
    kfbExportEncrypted,
    kfbDecodeAsset,
    getTextAssetRaw,
    applyTextAssetBytes,
    kfbApplyToAsset,
  };
});
