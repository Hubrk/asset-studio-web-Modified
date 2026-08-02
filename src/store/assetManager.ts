import type { AssetFileLoadOptions, TextureFormat } from '@arkntools/unity-js';
import { proxy, transfer, wrap } from 'comlink';
import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { RepoDataHandler } from '@/types/repository';
import { showBatchFilesResultMessage, showNotingCanBeExportToast } from '@/utils/toasts';
import type { BatchFilesResult } from '@/utils/toasts';
import { buildZipStore, type ZipEntry } from '@/utils/zipStore';
import type { AssetInfo, ExportAssetsOnProgress, FileLoadingOnProgress } from '@/workers/assetManager';
import AssetManagerWorker from '@/workers/assetManager/index.js?worker';
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

/** Trigger a browser download of an ArrayBuffer with the given file name. */
const downloadArrayBuffer = (buffer: ArrayBuffer, downloadName: string) => {
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
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
      const { errors, infos, successNum } = await (
        await manager
      ).loadFiles(
        files,
        {
          unityCNKey: setting.unityCNKey,
          env: setting.data.unityEnv,
          ...loadOptions,
        },
        onProgress,
      );
      assetInfos.value = infos;
      if (!infos.length) {
        ElMessage({
          message: `未从 ${files.length} 个文件中加载到任何资产`,
          type: 'warning',
        });
      } else if (files.length === 1 && errors.length) {
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

  const loadPreviewData = async (info: AssetInfo, payload?: any) => {
    return (await manager).getPreviewData(info.fileId, info.pathId, payload, await getDataHandler(info));
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
    modifyTexture2D,
    modifyTextAsset,
    modifySpritePixelsToUnits,
    modifyAssetByJson,
    getModifiedBundle,
    getModifiedBundleEncrypted,
    exportTextureToDir,
    loadSingleBundleSilently,
    previewVersion,
    pendingEditTab,
    modifiedFileIds,
    exportModifiedBundle,
    exportAllModifiedBundles,
  };
});
