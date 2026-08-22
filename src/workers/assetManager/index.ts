import { AssetType, ArrayBufferWriter, BundleFile, loadAssetBundle, serializeFromTypeTree, Sprite, TextAsset, Texture2D, TextureFormat } from '@arkntools/unity-js';
import type { AssetFile, AssetFileLoadOptions, AssetObject, ObjectInfo } from '@arkntools/unity-js';
import type { FsbConvertFormat } from '@arkntools/unity-js/audio';
import { FsaError, FsaErrorCode, FsaPromises } from '@tsuk1ko/fsa-promises';
import { expose } from 'comlink';
import { md5 as calcMd5 } from 'js-md5';
import { ExportGroupMethod } from '@/types/export';
import type { RepoBatchDataHandler, RepoDataHandler } from '@/types/repository';
import { decryptKhBundle, isKhBundle, isUnityFs, splitKhBundle, type KhBundleMeta } from '@/utils/khDecrypt';
import { encryptUnityFsToKh, computeCrc32Patch, CRC32_TABLE } from '@/utils/khEncrypt';
import { PromisePool } from '@/utils/promisePool';
import { bleedAlpha, encodeTextureWithMips, flipVerticalRgba, isFormatSupported, sharpenRgba, SHARPEN_PRESETS } from '@/utils/textureEncoder';
import { clearCache, createLoader } from './loaders';
import type { AssetExportItem, PreviewInfo } from './loaders';
import { AudioClipLoader } from './loaders/audioClip';
import { RenameProcessor } from './utils/rename';

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
  private bundleMap = new Map<string, AssetFile>();
  private unityFsMap = new Map<string, ArrayBuffer>();
  private khMetaMap = new Map<string, KhBundleMeta>();
  private fileNameMap = new Map<string, string>();
  private khMetaByFileName = new Map<string, KhBundleMeta>();
  private modifiedAssets = new Set<string>();
  /** 导出压缩模式：0=NONE(不压缩,默认) | 2=LZ4 | 3=LZ4_HC(游戏兼容) */
  private compressionMode = 0;

  setCompressionMode(mode: number) {
    this.compressionMode = mode;
  }

  getCompressionMode(): number {
    return this.compressionMode;
  }

  static setFsbConverter(fsbConverter: (typeof AudioClipLoader)['fsbConverter']) {
    AudioClipLoader.fsbConverter = fsbConverter;
  }

  static setFsbConvertFormat(fsbConvertFormat: FsbConvertFormat) {
    AudioClipLoader.convertFormat = fsbConvertFormat;
  }

  clear() {
    this.bundleMap.clear();
    this.unityFsMap.clear();
    this.khMetaMap.clear();
    this.khMetaByFileName.clear();
    this.fileNameMap.clear();
    this.modifiedAssets.clear();
    clearCache();
  }

  async loadFiles(files: File[], options: AssetFileLoadOptions, onProgress?: FileLoadingOnProgress) {
    const errors: Array<FileLoadingError> = [];
    const infos: AssetInfo[] = [];
    const usedKeys = new Set<string>();
    let successNum = 0;
    for (const [i, file] of files.entries()) {
      try {
        onProgress?.({
          name: file.name,
          progress: (i / files.length) * 100,
          totalAssetNum: infos.length,
        });
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
      }
    }
    return { errors, infos, successNum };
  }

  async getPreviewData(fileId: string, pathId: bigint, payload?: any, dataHandler?: RepoDataHandler) {
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return null;
    return await createLoader(obj).getPreviewData(payload, dataHandler);
  }

  async exportAsset(
    handle: FileSystemDirectoryHandle,
    fileId: string,
    pathId: bigint,
    dataHandler?: RepoDataHandler,
    customName?: string,
  ) {
    const obj = this.getAssetObj(fileId, pathId);
    if (!obj) return;
    const loader = createLoader(obj);
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
    pool.addTasks(new RenameProcessor().process(finalItems));
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

    const renameProcessor = new RenameProcessor();
    const objPathGetter = this.createObjPathGetter(groupMethod);

    await Promise.all(
      params.map(async ({ fileId, pathId, fileName, hasDataHandler }, i) => {
        const obj = this.getAssetObj(fileId, pathId);
        if (!obj) return minusTotalNum();
        const loader = createLoader(obj);
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

  private getAssetObj(fileId: string, pathId: bigint) {
    return this.bundleMap.get(fileId)?.objectMap.get(pathId);
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
    const pristineBuffer = buffer.slice(0);
    const md5 = calcMd5(pristineBuffer);

    const fileInfo = { fileId: md5, fileName: file.name };
    const bundle = this.bundleMap.get(md5) || (await loadAssetBundle(buffer, options));
    if (!this.bundleMap.has(md5)) {
      this.bundleMap.set(md5, bundle);
      this.unityFsMap.set(md5, pristineBuffer);
      this.fileNameMap.set(md5, file.name);
      if (khMeta) this.khMetaMap.set(md5, khMeta);
    }

    return Promise.all(
      bundle.objects
        .filter(obj => obj.type !== AssetType.AssetBundle)
        .map(async (obj): Promise<AssetInfo> => {
          const { name, type, pathId, size } = obj;
          const container = bundle.getContainer(pathId);
          const loader = createLoader(obj);
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

  getUnityFs(fileId: string): ArrayBuffer | undefined {
    return this.unityFsMap.get(fileId);
  }

  async getDecompressedUnityFs(fileId: string): Promise<ArrayBuffer | undefined> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) return undefined;
    const bundle = await loadAssetBundle(origFs.slice(0));
    return bundle.rebuild();
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

/** 锐化强度预设：0=关闭，1=轻度，2=适中（默认），3=较强 */
  async modifyTexture2D(
    fileId: string,
    pathId: bigint,
    rgbaData: ArrayBuffer,
    width: number,
    height: number,
    targetFormat?: TextureFormat,
    generateMips?: boolean,
    sharpen?: number,
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
    let rgba = bleedAlpha(flipped, width, height);
    const preset = sharpen ? SHARPEN_PRESETS[sharpen] : undefined;
    if (preset) rgba = sharpenRgba(rgba, width, height, preset);

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

    const rebuilt = bundle.rebuild();

    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);

    clearCache();
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  async modifyTextAsset(
    fileId: string,
    pathId: bigint,
    textData: string,
  ): Promise<boolean> {
    const origFs = this.unityFsMap.get(fileId);
    if (!origFs) throw new Error(`modifyTextAsset: file ${fileId} not found`);

    const bundle = await loadAssetBundle(origFs.slice(0));
    const obj = bundle.objectMap.get(pathId);
    if (!obj) throw new Error(`modifyTextAsset: object ${pathId} not found in bundle`);
    if (obj.type !== AssetType.TextAsset) {
      throw new Error(`modifyTextAsset: object ${pathId} is not a TextAsset (type=${obj.type})`);
    }
    const textAsset = obj as TextAsset;

    const textBytes = new TextEncoder().encode(textData);
    (textAsset as any)._modifiedTextData = textBytes;

    const objWriter = new ArrayBufferWriter(textBytes.length + 1024);
    textAsset.serialize(objWriter);
    const serialized = objWriter.getBuffer().slice(0, objWriter.position);

    const objInfo = (textAsset as any).__info as ObjectInfo;
    objInfo._modifiedData = serialized;

    const asset = objInfo.asset;
    const rebuiltAsset = asset.rebuild();

    const assetPath = objInfo.asset.path;
    const assetNodeIndex = bundle.nodes.findIndex(n => n.path === assetPath);
    if (assetNodeIndex === -1) {
      throw new Error(`modifyTextAsset: cannot find asset file "${assetPath}" in bundle nodes`);
    }
    bundle.files[assetNodeIndex] = rebuiltAsset;

    const rebuilt = bundle.rebuild();
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache();
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
    const rebuilt = bundle.rebuild();
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache();
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

    const rebuilt = bundle.rebuild();
    this.unityFsMap.set(fileId, rebuilt);
    this.bundleMap.delete(fileId);
    const newBundle = await loadAssetBundle(rebuilt.slice(0));
    this.bundleMap.set(fileId, newBundle);
    clearCache();
    this.modifiedAssets.add(`${fileId}_${pathId}`);

    return true;
  }

  async encryptBundleToKh(fileId: string, signature?: string): Promise<ArrayBuffer | undefined> {
    const raw = this.unityFsMap.get(fileId);
    if (!raw || !isUnityFs(raw)) return undefined;
    const meta = this.khMetaMap.get(fileId);
    const fileName = this.fileNameMap.get(fileId);

    // 游戏完整性校验规则（字节实证，8/8 原版样本）：
    //   CRC32(解压后的 blockData) == 文件名数字
    // 原版数据天然满足；修改资源后必须补丁。补丁必须位于「节点数据流」内
    // （rebuild 以 files 拼接 blockData，节点之外的尾部补丁会被丢弃），因此
    // 追加到 resS 流节点尾部——Texture2D 按自身 streamData.offset/size 读取，
    // 流尾 4 字节不影响资产，且随 rebuild(0/3) 一同进入明文/压缩数据，
    // 解压后 CRC 校验通过。旧流程（对压缩字节尾部打补丁）解压后补丁不存在，
    // 且可能污染 LZ4 流 → 游戏判定资源损坏。
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
  private appendCrcPatchToBundle(bundle: AssetFile, fileName: string): boolean {
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
}

expose({ AssetManager });
