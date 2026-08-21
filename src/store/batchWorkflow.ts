import { TextureFormat } from '@arkntools/unity-js';
import { defineStore } from 'pinia';
import { useBackgroundRemoval } from '@/composables/useBackgroundRemoval';
import { useTfjsBgRemoval } from '@/composables/useTfjsBgRemoval';
import { useFastBgRemoval } from '@/composables/useFastBgRemoval';
import {
  extractSizeFromImageName,
  extractTextureNameIndex,
  matchImagesToTextures,
  matchImagesToTexturesBySize,
  matchName,
  DEFAULT_MATCH_OPTIONS,
  type BundleAssetList,
  type MatchResult,
  type MatchMode,
  type MatchOptions,
} from '@/utils/imageMatching';
import { useAssetManager } from './assetManager';

export interface BatchTaskItem {
  bundleFileName: string;
  textureName: string;
  imageName: string;
  pathId: bigint;
  /** bundle 文件的 File 对象（扫描时缓存，用于执行时加载） */
  bundleFile?: File;
  status: 'pending' | 'loading' | 'removebg' | 'encoding' | 'writing' | 'done' | 'error' | 'skipped';
  error?: string;
  /** 兜底匹配：图片尺寸与纹理不一致，需裁剪下方一定比例后再缩放 */
  isFallback?: boolean;
}

export interface ExportTextureTaskItem {
  /** bundle 文件相对输入目录的路径，如 "90901漩涡鸣人/头像1/xxx.assetbundle" */
  bundleRelPath: string;
  /** 纹理名（不含扩展名） */
  textureName: string;
  /** 导出文件名，如 "hero_icon.png" */
  exportFileName: string;
  pathId: bigint;
  status: 'pending' | 'loading' | 'exporting' | 'writing' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface FilterResolutionTaskItem {
  /** bundle 文件相对输入目录的路径 */
  bundleRelPath: string;
  /** 纹理名 */
  textureName: string;
  /** 纹理实际分辨率，如 "460x500" */
  resolution: string;
  /** 纹理宽度 */
  width: number;
  /** 纹理高度 */
  height: number;
  pathId: bigint;
  /** 导出文件名，如 "hero_460x500.png" */
  exportFileName: string;
  status: 'pending' | 'loading' | 'exporting' | 'writing' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface ImageMatchTaskItem {
  /** 输入文件夹中图片文件名（不含扩展名） */
  imageName: string;
  /** 输入文件夹中图片原始文件名（含扩展名） */
  sourceFileName: string;
  /** 搜索结果：匹配到的图片文件名（含扩展名） */
  matchedFileName: string;
  /** 输出文件名 = 匹配名 + 后缀 + 扩展名 */
  outputFileName: string;
  status: 'pending' | 'copying' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface AssetMatchTaskItem {
  /** 输入图片文件名（含扩展名） */
  sourceFileName: string;
  /** 匹配到的资产文件夹名（所在目录名） */
  matchedFolderName: string;
  /** 该文件夹中匹配到的 PNG 文件名（含扩展名） */
  matchedImageName: string;
  /** 该文件夹中的 .assetbundle 文件名列表 */
  bundleFiles: string[];
  /** 该文件夹中 .assetbundle 文件数量 */
  bundleCount: number;
  status: 'pending' | 'copying' | 'done' | 'error' | 'skipped';
  error?: string;
}

export interface BatchWorkflowState {
  inputDirHandle: FileSystemDirectoryHandle | null;
  outputDirHandle: FileSystemDirectoryHandle | null;
  enableRemoveBg: boolean;
  targetFormat: TextureFormat | -1;
  generateMips: boolean;
  removeBgThreshold: number;
  removeBgFeather: boolean;
  removeBgMaxSize: number;
  /** 兜底裁剪比例（0-1，表示裁剪下方百分比，默认 0.13 = 13%） */
  fallbackCropRatio: number;
  /** 每批处理的最上层文件夹数量（exportTextures 模式） */
  batchSize: number;
  tasks: BatchTaskItem[];
  /** 导出纹理到 bundle 原目录模式的任务列表 */
  exportTextureTasks: ExportTextureTaskItem[];
  /** 分辨率筛选模式的任务列表 */
  filterResolutionTasks: FilterResolutionTaskItem[];
  /** 当前模式 */
  mode: 'replace' | 'exportTextures' | 'filterByResolution' | 'imageMatchAndCopy' | 'assetMatchAndCopy';
  /** 分辨率筛选模式：用户输入的目标分辨率列表 */
  filterResolutions: string[];
  /** 分辨率筛选模式：用户输入的纹理名称关键词列表 */
  filterTextureNames: string[];
  /** 分辨率筛选模式：分辨率与纹理名称的逻辑关系 */
  filterLogic: 'and' | 'or';
  /** 分辨率筛选模式：名称匹配模式 */
  filterNameMatchMode: MatchMode;
  /** 分辨率筛选模式：名称忽略大小写 */
  filterNameCaseInsensitive: boolean;
  /** 分辨率筛选模式：输出目录 handle */
  filterOutputDirHandle: FileSystemDirectoryHandle | null;
  /** 图片匹配复制模式：搜索目录 handle */
  imageMatchSearchDirHandle: FileSystemDirectoryHandle | null;
  /** 图片匹配复制模式：输出目录 handle */
  imageMatchOutputDirHandle: FileSystemDirectoryHandle | null;
  /** 图片匹配复制模式：输出文件后缀 */
  imageMatchSuffix: string;
  /** 图片匹配复制模式：匹配模式 */
  imageMatchMode: MatchMode;
  /** 图片匹配复制模式：忽略大小写 */
  imageMatchCaseInsensitive: boolean;
  /** 图片匹配复制模式：自定义正则 */
  imageMatchRegexPattern: string;
  /** 图片匹配复制模式：任务列表 */
  imageMatchTasks: ImageMatchTaskItem[];
  /** 图片匹配复制模式：未匹配的图片 */
  imageMatchUnmatched: string[];
  /** 资产匹配复制模式：资产库目录（含 PNG 和 .assetbundle） */
  assetMatchSearchDirHandle: FileSystemDirectoryHandle | null;
  /** 资产匹配复制模式：任务列表 */
  assetMatchTasks: AssetMatchTaskItem[];
  /** 资产匹配复制模式：未匹配的图片 */
  assetMatchUnmatched: string[];
  /** 资产匹配复制模式：跳过重复的文件夹数 */
  assetMatchSkipCount: number;
  isRunning: boolean;
  currentTaskIndex: number;
  /** 当前批次索引（0-based），-1 表示未开始 */
  currentBatchIndex: number;
  /** 总批次数 */
  totalBatchCount: number;
  totalProgress: number; // 0-1
  stageText: string;
  matchedResults: MatchResult[];
  unmatchedImages: string[];
  unmatchedTextures: string[];
}

const BUNDLE_EXT_RE = /\.(?:assetbundle|ab)$/i;
const IMAGE_EXT_RE = /\.(?:png|jpg|jpeg)$/i;

export const useBatchWorkflow = defineStore('batchWorkflow', () => {
  const assetManager = useAssetManager();
  // composable 必须在 setup 顶部调用，不能在函数内
  const bgRemoval = useBackgroundRemoval();
  const tfjsBgRemoval = useTfjsBgRemoval();
  const fastBgRemoval = useFastBgRemoval();

  // === State ===
  const inputDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const outputDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const enableRemoveBg = ref(false);
  /** 抠图模型选择：'onnx' = RMBG-1.4, 'tfjs' = Removebg 1.6, 'fast' = Removebg 1.5 Fast */
  const removeBgModelType = ref<'onnx' | 'tfjs' | 'fast'>('onnx');
  const targetFormat = ref<TextureFormat | -1>(TextureFormat.RGBA32);
  const generateMips = ref(false);
  const removeBgThreshold = ref(128);
  const removeBgFeather = ref(true);
  const removeBgMaxSize = ref(1024);
  const fallbackCropRatio = ref(0.13);
  /** 兜底裁剪方向：'bottom'=保留顶部裁下方（默认）| 'top'=保留底部裁上方 | 'center'=居中裁上下 */
  const fallbackCropDirection = ref<'bottom' | 'top' | 'center'>('bottom');
  /** 启用通用裁剪：对所有图片都按兜底比例裁剪（不再需要 isFallback/比例差/Portrait 条件） */
  const universalCrop = ref(false);
  const batchSize = ref(100);
  const matchSuffix = ref('_generated');
  /** 导出纹理模式：是否在文件名中加入 bundle 资产文件名 */
  const includeBundleName = ref(false);

  const tasks = ref<BatchTaskItem[]>([]);
  const exportTextureTasks = ref<ExportTextureTaskItem[]>([]);
  const filterResolutionTasks = ref<FilterResolutionTaskItem[]>([]);
  const mode = ref<'replace' | 'exportTextures' | 'filterByResolution' | 'imageMatchAndCopy' | 'assetMatchAndCopy'>('replace');
  const filterResolutions = ref<string[]>([]);
  const filterTextureNames = ref<string[]>([]);
  const filterLogic = ref<'and' | 'or'>('and');
  const filterNameMatchMode = ref<MatchMode>('contains');
  const filterNameCaseInsensitive = ref(true);
  const filterOutputDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const exportOriginalBundle = ref(true);
  const imageMatchSearchDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const imageMatchOutputDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const imageMatchSuffix = ref('_copied');
  const imageMatchMode = ref<MatchMode>('exact');
  const imageMatchCaseInsensitive = ref(false);
  const imageMatchRegexPattern = ref('');
  const imageMatchTasks = ref<ImageMatchTaskItem[]>([]);
  const imageMatchUnmatched = ref<string[]>([]);
  const assetMatchSearchDirHandle = shallowRef<FileSystemDirectoryHandle | null>(null);
  const assetMatchTasks = ref<AssetMatchTaskItem[]>([]);
  const assetMatchUnmatched = ref<string[]>([]);
  const assetMatchSkipCount = ref(0);
  /** 非响应式 Map：任务索引 → 匹配到的资产文件夹 handle（用于读取 .assetbundle） */
  const assetMatchFolderHandles = new Map<number, FileSystemDirectoryHandle>();
  /** 非响应式 Map：任务索引 → 来源图片所在目录 handle（用于写入 .assetbundle） */
  const assetMatchSourceDirHandles = new Map<number, FileSystemDirectoryHandle>();
  const isRunning = ref(false);
  const currentTaskIndex = ref(-1);
  const currentBatchIndex = ref(-1);
  const totalBatchCount = ref(0);
  const totalProgress = ref(0);
  const stageText = ref('');
  const matchedResults = ref<MatchResult[]>([]);
  const unmatchedImages = ref<string[]>([]);
  const unmatchedTextures = ref<string[]>([]);

  // 图片名 → File 的缓存（previewMatch 时填充，run 时消费）
  // 不放入响应式 state，避免大量 File 触发响应式开销
  const imageFileMap = new Map<string, File>();
  // bundle 相对路径 → 父目录 handle 的缓存（exportTextures 模式使用）
  // 递归扫描时填充，runExportTextures 时消费
  const bundleDirHandleMap = new Map<string, FileSystemDirectoryHandle>();
  // bundle 相对路径 → File handle 的缓存（避免执行时重复遍历目录树）
  const bundleFileHandleMap = new Map<string, FileSystemFileHandle>();
  // bundle 相对路径 → File 的缓存（扫描时已读取，执行时直接取）
  const bundleFileMap = new Map<string, File>();
  // bundle 文件名 → 所在目录相对路径（previewMatch 时填充，run 时消费）
  const bundleFileToBaseDir = new Map<string, string>();
  // 目录相对路径 → FileSystemDirectoryHandle（previewMatch 扫描时缓存，run 时用于写回同目录）
  const bundleDirHandleByPath = new Map<string, FileSystemDirectoryHandle>();

  // === Actions ===

  const setInputDir = (handle: FileSystemDirectoryHandle | null) => {
    inputDirHandle.value = handle;
  };

  const setOutputDir = (handle: FileSystemDirectoryHandle | null) => {
    outputDirHandle.value = handle;
  };

  const setFilterOutputDir = (handle: FileSystemDirectoryHandle | null) => {
    filterOutputDirHandle.value = handle;
  };

  /** 解析用户输入的分辨率字符串，如 "460x500" → { width: 460, height: 500 } */
  const parseResolution = (s: string): { width: number; height: number } | null => {
    const m = s.trim().match(/^(\d+)\s*[x×*]\s*(\d+)$/i);
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (!w || !h || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  };

  /** 添加目标分辨率（自动去重、归一化为 WxH 格式） */
  const addResolution = (raw: string): boolean => {
    const parsed = parseResolution(raw);
    if (!parsed) return false;
    const normalized = `${parsed.width}x${parsed.height}`;
    if (filterResolutions.value.includes(normalized)) return false;
    filterResolutions.value = [...filterResolutions.value, normalized];
    return true;
  };

  const removeResolution = (index: number) => {
    filterResolutions.value = filterResolutions.value.filter((_, i) => i !== index);
  };

  const clearResolutions = () => {
    filterResolutions.value = [];
  };

  /** 添加纹理名称关键词（自动去重、去空白） */
  const addTextureName = (raw: string): boolean => {
    const name = raw.trim();
    if (!name) return false;
    if (filterTextureNames.value.includes(name)) return false;
    filterTextureNames.value = [...filterTextureNames.value, name];
    return true;
  };

  const removeTextureName = (index: number) => {
    filterTextureNames.value = filterTextureNames.value.filter((_, i) => i !== index);
  };

  const clearTextureNames = () => {
    filterTextureNames.value = [];
  };

  const setFilterLogic = (logic: 'and' | 'or') => {
    filterLogic.value = logic;
  };

  const initRemoveBgModel = () => {
    if (removeBgModelType.value === 'tfjs') {
      return tfjsBgRemoval.init();
    }
    if (removeBgModelType.value === 'fast') {
      return fastBgRemoval.init();
    }
    return bgRemoval.init();
  };

  /** 当前激活的抠图 composable（根据模型选择切换） */
  const activeBgRemoval = computed(() => {
    if (removeBgModelType.value === 'tfjs') return tfjsBgRemoval;
    if (removeBgModelType.value === 'fast') return fastBgRemoval;
    return bgRemoval;
  });

  /**
   * 递归扫描输入目录，收集所有 .assetbundle 和 .png/.jpg 图片
   * 按文件夹分组：同一文件夹内的图片和 bundle 互相匹配
   * 使用尺寸匹配：图片文件名中的 _1024x1024 用于匹配纹理尺寸
   */
  const previewMatch = async () => {
    const dirHandle = inputDirHandle.value;
    if (!dirHandle) {
      ElMessage({ message: '请先选择输入目录', type: 'warning' });
      return;
    }

    stageText.value = '正在递归扫描输入目录...';

    // 递归扫描：收集所有 bundle 和图片，按父目录分组
    // key = 父目录相对路径，value = { bundles: File[], images: File[] }
    const dirToFiles = new Map<string, { bundles: File[]; images: File[] }>();
    imageFileMap.clear();

    const scanDir = async (handle: FileSystemDirectoryHandle, basePath: string) => {
      // 缓存目录 handle，供 run 时写回同目录
      bundleDirHandleByPath.set(basePath, handle);
      let group = dirToFiles.get(basePath);
      if (!group) {
        group = { bundles: [], images: [] };
        dirToFiles.set(basePath, group);
      }
      for await (const [name, entry] of handle.entries()) {
        const fullPath = basePath ? `${basePath}/${name}` : name;
        if (entry.kind === 'directory') {
          await scanDir(entry as FileSystemDirectoryHandle, fullPath);
        } else if (entry.kind === 'file') {
          const file = await (entry as FileSystemFileHandle).getFile();
          if (BUNDLE_EXT_RE.test(name)) {
            group.bundles.push(file);
          } else if (IMAGE_EXT_RE.test(name)) {
            group.images.push(file);
            imageFileMap.set(fullPath, file);
          }
        }
      }
    };

    await scanDir(dirHandle, '');

    // 收集所有 bundle 文件
    const allBundles: File[] = [];
    for (const [, group] of dirToFiles) {
      allBundles.push(...group.bundles);
    }

    if (!allBundles.length) {
      ElMessage({ message: '输入目录中未找到 .assetbundle/.ab 文件', type: 'warning' });
      stageText.value = '';
      return;
    }

    stageText.value = `正在加载 ${allBundles.length} 个 bundle...`;
    await assetManager.loadFiles(allBundles);

    // 从 assetInfos 构建 BundleAssetList[]，带 width/height
    const byFileName = new Map<string, BundleAssetList>();
    for (const info of assetManager.assetInfos) {
      let list = byFileName.get(info.fileName);
      if (!list) {
        list = { fileName: info.fileName, assets: [] };
        byFileName.set(info.fileName, list);
      }
      const preview = info.preview as { width?: number; height?: number };
      list.assets.push({
        name: info.name,
        pathId: info.pathId,
        type: info.type,
        width: preview?.width,
        height: preview?.height,
      });
    }
    const bundleAssetLists: BundleAssetList[] = Array.from(byFileName.values());

    const index = extractTextureNameIndex(bundleAssetLists);

    // 按文件夹匹配：每个文件夹内的图片和 bundle 互相匹配
    const allMatches: MatchResult[] = [];
    const allImageNames = new Set<string>();

    // 构建 bundleFileName → baseDir 的映射（用于后续执行时找到目录 handle）
    bundleFileToBaseDir.clear();
    for (const [basePath, group] of dirToFiles) {
      for (const bf of group.bundles) {
        bundleFileToBaseDir.set(bf.name, basePath);
      }
    }

    // 构建 bundleFileName → File 的映射（用于执行时加载）
    const bundleFileByName = new Map<string, File>();
    for (const bf of allBundles) {
      bundleFileByName.set(bf.name, bf);
    }

    for (const [basePath, group] of dirToFiles) {
      let imageNames = group.images.map(f => f.name);
      // 如果设置了匹配后缀，只匹配带该后缀的图片，跳过不带后缀的
      const suffix = matchSuffix.value;
      if (suffix) {
        imageNames = imageNames.filter(name => {
          const nameNoExt = name.replace(/\.[^.]+$/, '');
          return nameNoExt.endsWith(suffix);
        });
      }
      for (const n of imageNames) allImageNames.add(n);

      const matches = matchImagesToTexturesBySize(index, imageNames, matchSuffix.value || undefined);
      // 只保留同一文件夹内的匹配（bundle 和图片在同一目录）
      for (const m of matches) {
        const bundleBaseDir = bundleFileToBaseDir.get(m.bundleFileName);
        if (bundleBaseDir === basePath) {
          allMatches.push(m);
        }
      }
    }

    // 兜底匹配：对精确匹配未命中的纹理，用同名但不同尺寸的图片兜底
    // 执行时会裁剪下方 20% 再缩放到原始纹理尺寸
    const matchedTexKeys = new Set(allMatches.map(m => `${m.bundleFileName}|${m.textureName}`));
    for (const [basePath, group] of dirToFiles) {
      let imageNames = group.images.map(f => f.name);
      const suffix = matchSuffix.value;
      if (suffix) {
        imageNames = imageNames.filter(name => {
          const nameNoExt = name.replace(/\.[^.]+$/, '');
          return nameNoExt.endsWith(suffix);
        });
      }
      for (const imageName of imageNames) {
        const sizeInfo = extractSizeFromImageName(imageName, suffix || undefined);
        const baseName = sizeInfo ? sizeInfo.baseName : imageName.replace(/\.[^.]+$/, '');
        const entries = index.get(baseName);
        if (!entries) continue;
        for (const entry of entries) {
          const texKey = `${entry.bundleFileName}|${entry.textureName}`;
          if (matchedTexKeys.has(texKey)) continue;
          // 确保同一文件夹
          const bundleBaseDir = bundleFileToBaseDir.get(entry.bundleFileName);
          if (bundleBaseDir !== basePath) continue;
          allMatches.push({
            imageName,
            bundleFileName: entry.bundleFileName,
            pathId: entry.pathId,
            textureName: entry.textureName,
            isFallback: true,
          });
          matchedTexKeys.add(texKey);
          // 一张图片可兜底匹配多个纹理，不 break
        }
      }
    }

    // 计算未匹配
    const matchedImageSet = new Set(allMatches.map(m => m.imageName));
    const matchedTextureKeys = new Set(allMatches.map(m => `${m.bundleFileName}|${m.textureName}`));
    const unmatchedImgs = Array.from(allImageNames).filter(n => !matchedImageSet.has(n));
    const unmatchedTexs: string[] = [];
    for (const [, entries] of index) {
      for (const e of entries) {
        if (!matchedTextureKeys.has(`${e.bundleFileName}|${e.textureName}`)) {
          unmatchedTexs.push(`${e.bundleFileName} :: ${e.textureName}`);
        }
      }
    }

    matchedResults.value = allMatches;
    unmatchedImages.value = unmatchedImgs;
    unmatchedTextures.value = unmatchedTexs;
    tasks.value = allMatches.map(m => ({
      bundleFileName: m.bundleFileName,
      textureName: m.textureName,
      imageName: m.imageName,
      pathId: m.pathId,
      bundleFile: bundleFileByName.get(m.bundleFileName),
      status: 'pending' as const,
      isFallback: m.isFallback ?? false,
    }));
    totalProgress.value = 0;
    currentTaskIndex.value = -1;
    stageText.value = `匹配完成：${allMatches.length} 项（${dirToFiles.size} 个文件夹），未匹配图片 ${unmatchedImgs.length}，未匹配纹理 ${unmatchedTexs.length}`;
  };

  /**
   * 递归扫描输入目录，收集所有 .assetbundle 文件
   * 同时缓存 fileHandle 和 file 到 Map，避免执行时重复遍历目录树
   * 填充 bundleDirHandleMap / bundleFileHandleMap / bundleFileMap
   */
  const scanBundlesRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    basePath = '',
  ): Promise<Array<{ relPath: string; file: File; dirHandle: FileSystemDirectoryHandle }>> => {
    const result: Array<{ relPath: string; file: File; dirHandle: FileSystemDirectoryHandle }> = [];
    for await (const [name, handle] of dirHandle.entries()) {
      const fullPath = basePath ? `${basePath}/${name}` : name;
      if (handle.kind === 'directory') {
        // 递归子目录
        const sub = await scanBundlesRecursive(handle as FileSystemDirectoryHandle, fullPath);
        result.push(...sub);
      } else if (handle.kind === 'file' && BUNDLE_EXT_RE.test(name)) {
        const fileHandle = handle as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        result.push({ relPath: fullPath, file, dirHandle });
        bundleDirHandleMap.set(fullPath, dirHandle);
        bundleFileHandleMap.set(fullPath, fileHandle);
        bundleFileMap.set(fullPath, file);
      }
    }
    return result;
  };

  /**
   * 按最上层文件夹分组 bundle entries
   * relPath 第一段作为组 key（如 "90901漩涡鸣人/头像1/x.ab" → "90901漩涡鸣人"）
   * 顶层直接文件归到 "" 组
   */
  const groupByTopFolder = <T extends { relPath: string }>(entries: T[]): Map<string, T[]> => {
    const groups = new Map<string, T[]>();
    for (const e of entries) {
      const sep = e.relPath.indexOf('/');
      const top = sep === -1 ? '' : e.relPath.slice(0, sep);
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top)!.push(e);
    }
    return groups;
  };

  /**
   * 导出纹理到 bundle 原目录模式：扫描预览
   * 仅递归扫描目录收集 bundle 文件列表，不加载 bundle（避免内存爆炸）
   * 实际纹理列表在 runExportTextures 时逐个加载动态生成
   */
  const previewExportTextures = async () => {
    const dirHandle = inputDirHandle.value;
    if (!dirHandle) {
      ElMessage({ message: '请先选择输入目录', type: 'warning' });
      return;
    }

    stageText.value = '正在递归扫描输入目录...';
    bundleDirHandleMap.clear();
    const bundleEntries = await scanBundlesRecursive(dirHandle);

    if (!bundleEntries.length) {
      ElMessage({ message: '输入目录中未找到 .assetbundle/.ab 文件（已递归子目录）', type: 'warning' });
      stageText.value = '';
      exportTextureTasks.value = [];
      return;
    }

    // 仅生成 bundle 级别的占位任务（不含纹理详情，执行时动态更新）
    exportTextureTasks.value = bundleEntries.map(e => ({
      bundleRelPath: e.relPath,
      textureName: '(待加载)',
      exportFileName: '',
      pathId: 0n,
      status: 'pending' as const,
    }));

    totalProgress.value = 0;
    currentTaskIndex.value = -1;
    stageText.value = `扫描完成：${bundleEntries.length} 个 bundle 待处理（点击"开始导出"逐个加载并导出纹理）`;
  };

  /**
   * 执行导出纹理到 bundle 原目录
   * 按最上层文件夹分批处理：每批处理 batchSize 个最上层文件夹
   * 批次内逐个 bundle 加载 → 导出 → 下一个
   * 批次间让出主线程，触发响应式更新，让浏览器回收内存和刷新 UI
   */
  const runExportTextures = async () => {
    if (isRunning.value) return;
    if (!exportTextureTasks.value.length) {
      ElMessage({ message: '没有可执行的任务，请先扫描预览', type: 'warning' });
      return;
    }

    // 预请求所有涉及目录的 readwrite 权限（必须在用户激活上下文中调用）
    const uniqueDirs = new Set<FileSystemDirectoryHandle>();
    for (const task of exportTextureTasks.value) {
      const handle = bundleDirHandleMap.get(task.bundleRelPath);
      if (handle) uniqueDirs.add(handle);
    }
    for (const dir of uniqueDirs) {
      if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        const result = await dir.requestPermission({ mode: 'readwrite' });
        if (result !== 'granted') {
          ElMessage({ message: '目录权限被拒绝，无法写入文件', type: 'error' });
          return;
        }
      }
    }

    isRunning.value = true;
    const total = exportTextureTasks.value.length;
    let totalExported = 0;

    // 跨 bundle 去重：按目录维护文件名计数器，避免同名纹理互相覆盖
    // key = bundle 父目录路径，value = Map<文件名, 出现次数>
    const dirRenameMaps = new Map<string, Map<string, number>>();

    // 按任务（bundle）数量分批，每批处理 batchSize 个任务
    const bSize = Math.max(1, batchSize.value);
    const totalBatches = Math.max(1, Math.ceil(total / bSize));
    totalBatchCount.value = totalBatches;

    // 用 markRaw 包装任务对象，避免响应式追踪属性修改
    // 每批次结束统一 triggerRef 更新 UI
    const localTasks = exportTextureTasks.value.map(t => markRaw({ ...t }));
    let globalIdx = 0;

    try {
      for (let bi = 0; bi < totalBatches; bi++) {
        if (!isRunning.value) break;
        currentBatchIndex.value = bi;
        const startIdx = bi * bSize;
        const endIdx = Math.min(startIdx + bSize, total);

        // 处理这一批的所有任务
        for (let i = startIdx; i < endIdx; i++) {
          if (!isRunning.value) break;
          const task = localTasks[i];

          currentTaskIndex.value = globalIdx;

          try {
            task.status = 'loading';
            const dirHandle = bundleDirHandleMap.get(task.bundleRelPath);
            if (!dirHandle) throw new Error(`找不到 bundle 所在目录 handle：${task.bundleRelPath}`);
            // 权限已在 runExportTextures() 开始时预请求

            // 直接从缓存取 File（扫描时已读取），避免重复遍历目录树
            const file = bundleFileMap.get(task.bundleRelPath);
            if (!file) throw new Error(`找不到 bundle 文件：${task.bundleRelPath}`);

            // 静默加载单个 bundle（内部会先 clear 释放上一个 bundle 内存）
            task.status = 'exporting';
            stageText.value = `[批次 ${bi + 1}/${totalBatches}] [${globalIdx + 1}/${total}] ${task.bundleRelPath}`;
            const infos = await assetManager.loadSingleBundleSilently(file);

            // 过滤 Texture2D，逐个导出
            const textureInfos = infos.filter(info => info.type === 'Texture2D');
            let bundleExported = 0;
            let bundleFailed = 0;
            const errors: string[] = [];

            // 按目录维护去重计数器：同名同尺寸纹理自动加序号
            // key = bundle 父目录路径，value = Map<文件名, 出现次数>
            const dirKey = task.bundleRelPath.includes('/')
              ? task.bundleRelPath.slice(0, task.bundleRelPath.lastIndexOf('/'))
              : '';
            let dirRenameMap = dirRenameMaps.get(dirKey);
            if (!dirRenameMap) {
              dirRenameMap = new Map();
              dirRenameMaps.set(dirKey, dirRenameMap);
            }

            for (const info of textureInfos) {
              if (!isRunning.value) break;
              try {
                // 生成带尺寸后缀的文件名：hero → hero_1024x1024
                // 从 preview 拿 width/height（Texture2D 类型已填充）
                const preview = info.preview as { width?: number; height?: number };
                const w = preview?.width;
                const h = preview?.height;
                const baseName = info.name || `texture_${info.pathId}`;
                const sizeSuffix = w && h ? `_${w}x${h}` : '';
                let customName = `${baseName}${sizeSuffix}`;

                // 可选：在文件名中加入 bundle 资产文件名
                if (includeBundleName.value) {
                  const bundleBaseName = task.bundleRelPath.includes('/')
                    ? task.bundleRelPath.slice(task.bundleRelPath.lastIndexOf('/') + 1)
                    : task.bundleRelPath;
                  const bundleNameNoExt = bundleBaseName.replace(/\.(?:assetbundle|ab)$/i, '');
                  if (bundleNameNoExt && bundleNameNoExt !== customName) {
                    customName = `${customName}_${bundleNameNoExt}`;
                  }
                }

                // 跨 bundle 去重：同名同尺寸自动加序号
                const count = dirRenameMap.get(customName) || 0;
                if (count > 0) {
                  customName = `${customName} (${count})`;
                }
                dirRenameMap.set(customName, (dirRenameMap.get(customName) || 0) + 1);

                const result = await assetManager.exportTextureToDir(
                  info.fileId,
                  info.pathId,
                  dirHandle,
                  customName,
                );
                if (result && result.success > 0) {
                  bundleExported++;
                  totalExported++;
                } else {
                  bundleFailed++;
                }
              } catch (e) {
                bundleFailed++;
                errors.push(`${info.name}: ${String(e)}`);
              }
            }

            // 更新任务状态
            if (textureInfos.length === 0) {
              task.status = 'skipped';
              task.textureName = '(无纹理)';
              task.error = '该 bundle 内无 Texture2D 资产';
            } else if (bundleFailed === 0) {
              task.status = 'done';
              task.textureName = `${textureInfos.length} 个纹理`;
              task.exportFileName = `成功 ${bundleExported}`;
            } else if (bundleExported > 0) {
              task.status = 'done';
              task.textureName = `${textureInfos.length} 个纹理`;
              task.exportFileName = `成功 ${bundleExported}，失败 ${bundleFailed}`;
              task.error = errors.slice(0, 3).join('; ');
            } else {
              task.status = 'error';
              task.textureName = `${textureInfos.length} 个纹理`;
              task.error = `全部导出失败：${errors.slice(0, 2).join('; ')}`;
            }
          } catch (e) {
            task.status = 'error';
            task.error = String(e);
            console.error(`[BatchWorkflow] bundle (${task.bundleRelPath}) failed:`, e);
          }
          totalProgress.value = (globalIdx + 1) / total;
          globalIdx++;
        }

        // 批次结束：触发响应式更新 + 让出主线程，让浏览器刷新 UI 和回收内存
        exportTextureTasks.value = [...localTasks];
        // 让出主线程 50ms，给浏览器渲染和 GC 时间
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }

      // 最终统一更新一次
      exportTextureTasks.value = [...localTasks];
      stageText.value = isRunning.value
        ? `导出完成：共导出 ${totalExported} 个纹理`
        : `已取消：共导出 ${totalExported} 个纹理`;
    } finally {
      isRunning.value = false;
      currentTaskIndex.value = -1;
      currentBatchIndex.value = -1;
      // 最后清理 worker 内存
      try {
        await assetManager.clearFiles();
      } catch {
        // 忽略清理错误
      }
    }
  };

  /**
   * 分辨率筛选模式：扫描预览
   * 递归扫描输入目录所有 bundle，逐个加载提取 Texture2D 分辨率，
   * 与用户输入的目标分辨率列表对比，匹配的纹理加入任务列表
   * 采用分批加载策略（按最上层文件夹分批），避免一次性加载所有 bundle 导致内存爆炸
   */
  const previewFilterByResolution = async () => {
    const dirHandle = inputDirHandle.value;
    if (!dirHandle) {
      ElMessage({ message: '请先选择输入目录', type: 'warning' });
      return;
    }
    if (!filterResolutions.value.length && !filterTextureNames.value.length) {
      ElMessage({ message: '请先添加至少一个目标分辨率或纹理名称', type: 'warning' });
      return;
    }

    isRunning.value = true;
    stageText.value = '正在递归扫描输入目录...';
    bundleDirHandleMap.clear();
    bundleFileHandleMap.clear();
    bundleFileMap.clear();
    const bundleEntries = await scanBundlesRecursive(dirHandle);

    if (!bundleEntries.length) {
      ElMessage({ message: '输入目录中未找到 .assetbundle/.ab 文件（已递归子目录）', type: 'warning' });
      stageText.value = '';
      filterResolutionTasks.value = [];
      isRunning.value = false;
      return;
    }

    // 构建目标分辨率 Set，归一化为 "WxH"
    const targetSet = new Set<string>();
    for (const r of filterResolutions.value) {
      const parsed = parseResolution(r);
      if (parsed) targetSet.add(`${parsed.width}x${parsed.height}`);
    }

    // 纹理名称关键词（根据匹配模式选择处理方式）
    const nameKeywords = filterTextureNames.value;
    const hasResolutionFilter = targetSet.size > 0;
    const hasNameFilter = nameKeywords.length > 0;
    const logic = filterLogic.value; // 'and' | 'or'
    const nameMode = filterNameMatchMode.value;
    const caseInsensitive = filterNameCaseInsensitive.value;

    /** 判断单个纹理是否通过筛选 */
    const matchTexture = (width: number, height: number, name: string): { matched: boolean; resKey: string } => {
      const resKey = `${width}x${height}`;
      const resMatched = hasResolutionFilter ? targetSet.has(resKey) : false;
      // 按选择的匹配模式处理每个关键词
      const nameMatched = hasNameFilter
        ? nameKeywords.some(kw => matchName(name, kw, {
          mode: nameMode,
          caseInsensitive,
        }))
        : false;

      let matched = false;
      if (hasResolutionFilter && hasNameFilter) {
        // 同时有两种条件，按逻辑关系
        matched = logic === 'and' ? (resMatched && nameMatched) : (resMatched || nameMatched);
      } else if (hasResolutionFilter) {
        matched = resMatched;
      } else if (hasNameFilter) {
        matched = nameMatched;
      }
      return { matched, resKey };
    };

    stageText.value = `正在加载 ${bundleEntries.length} 个 bundle 并提取纹理分辨率...`;
    const allTasks: FilterResolutionTaskItem[] = [];
    let processedBundleCount = 0;
    const totalBundles = bundleEntries.length;

    // 按 bundle 数量分批（而非按最上层文件夹数量），避免同一文件夹下大量 bundle 被合到一批
    // 批次大小 = batchSize，按 bundle 总数计算批次数
    const bSize = Math.max(1, batchSize.value);
    const totalBatches = Math.max(1, Math.ceil(totalBundles / bSize));
    totalBatchCount.value = totalBatches;

    try {
      for (let bi = 0; bi < totalBatches; bi++) {
        if (!isRunning.value) break;
        currentBatchIndex.value = bi;
        const startIdx = bi * bSize;
        const endIdx = Math.min(startIdx + bSize, totalBundles);
        const batchEntries = bundleEntries.slice(startIdx, endIdx);

        if (!batchEntries.length) continue;

      // 批量加载这一批的 bundle
      const batchFiles = batchEntries.map(e => e.file);
      stageText.value = `[批次 ${bi + 1}/${totalBatches}] 正在加载 ${batchFiles.length} 个 bundle...`;
      await assetManager.loadFiles(batchFiles);

        // 构建 fileName → relPath 映射（同目录可能有重名 bundle，用 relPath 唯一标识）
        const fileNameToRelPath = new Map<string, string>();
        for (const e of batchEntries) {
          // 同名 bundle 在不同目录时，以最后加载的为准（极少出现）
          fileNameToRelPath.set(e.file.name, e.relPath);
        }

        // 遍历 assetInfos 筛选匹配的 Texture2D
        for (const info of assetManager.assetInfos) {
          if (info.type !== 'Texture2D') continue;
          const preview = info.preview as { width?: number; height?: number };
          const w = preview?.width;
          const h = preview?.height;
          // 纹理名称匹配时不需要分辨率，但导出时仍需要 width/height
          // 若仅有分辨率筛选，则要求 w/h 必须存在
          if (hasResolutionFilter && (!w || !h)) continue;
          // 若仅有名称筛选，无 w/h 时用 0 占位（导出文件名会缺尺寸后缀）
          const actW = w ?? 0;
          const actH = h ?? 0;
          const texName = info.name || '';

          const { matched, resKey } = matchTexture(actW, actH, texName);
          if (!matched) continue;

          const relPath = fileNameToRelPath.get(info.fileName);
          if (!relPath) continue;

          const baseName = info.name || `texture_${info.pathId}`;
          // 有分辨率时加尺寸后缀，无分辨率时仅用纹理名
          const sizeSuffix = actW && actH ? `_${resKey}` : '';
          allTasks.push({
            bundleRelPath: relPath,
            textureName: info.name,
            resolution: resKey,
            width: actW,
            height: actH,
            pathId: info.pathId,
            exportFileName: `${baseName}${sizeSuffix}.png`,
            status: 'pending' as const,
          });
        }

        processedBundleCount += batchEntries.length;
        totalProgress.value = processedBundleCount / totalBundles;

        // 批次结束清理 worker 内存，避免累积
        try {
          await assetManager.clearFiles();
        } catch {
          // 忽略清理错误
        }
        // 让出主线程，触发 UI 更新
        await new Promise<void>(resolve => setTimeout(resolve, 30));
      }

      filterResolutionTasks.value = allTasks;
      totalProgress.value = 0;
      currentTaskIndex.value = -1;
      currentBatchIndex.value = -1;
      stageText.value = isRunning.value
        ? `扫描完成：共找到 ${allTasks.length} 个匹配的纹理（共扫描 ${totalBundles} 个 bundle）`
        : `已取消：共找到 ${allTasks.length} 个匹配的纹理`;
    } finally {
      isRunning.value = false;
      currentBatchIndex.value = -1;
      // 清理 worker 内存
      try {
        await assetManager.clearFiles();
      } catch {
        // 忽略
      }
    }
  };

  /**
   * 分辨率筛选模式：执行导出
   * 逐个 bundle 加载 → 导出匹配的纹理为 PNG → 写入用户指定的输出目录
   * 采用分批处理，避免内存堆积
   */
  const runFilterByResolution = async () => {
    if (isRunning.value) return;
    if (!filterResolutionTasks.value.length) {
      ElMessage({ message: '没有可执行的任务，请先扫描预览', type: 'warning' });
      return;
    }
    const outDir = filterOutputDirHandle.value;
    if (!outDir) {
      ElMessage({ message: '请先选择输出目录', type: 'warning' });
      return;
    }

    // 预请求输出目录权限（必须在用户激活上下文中调用）
    if ((await outDir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      try {
        const result = await outDir.requestPermission({ mode: 'readwrite' });
        if (result !== 'granted') {
          ElMessage({ message: '输出目录权限被拒绝，请重新选择', type: 'error' });
          return;
        }
      } catch {
        ElMessage({ message: '输出目录权限被拒绝，请重新选择', type: 'error' });
        return;
      }
    }

    isRunning.value = true;
    const total = filterResolutionTasks.value.length;

    // 按 bundleRelPath 分组，同一 bundle 的多个纹理一次性加载处理
    const tasksByBundle = new Map<string, FilterResolutionTaskItem[]>();
    for (const t of filterResolutionTasks.value) {
      let arr = tasksByBundle.get(t.bundleRelPath);
      if (!arr) {
        arr = [];
        tasksByBundle.set(t.bundleRelPath, arr);
      }
      arr.push(t);
    }

    // 跨 bundle 去重：按输出目录维护文件名计数器
    const globalRenameMap = new Map<string, number>();

    const localTasks = filterResolutionTasks.value.map(t => markRaw({ ...t }));
    let globalIdx = 0;
    let totalExported = 0;

    // 按 bundle 数量分批，每批处理 batchSize 个 bundle
    const bundleRelPaths = Array.from(tasksByBundle.keys());
    const totalBundles = bundleRelPaths.length;
    const bSize = Math.max(1, batchSize.value);
    const totalBatches = Math.max(1, Math.ceil(totalBundles / bSize));
    totalBatchCount.value = totalBatches;

    try {
      for (let bi = 0; bi < totalBatches; bi++) {
        if (!isRunning.value) break;
        currentBatchIndex.value = bi;
        const startIdx = bi * bSize;
        const endIdx = Math.min(startIdx + bSize, totalBundles);
        const batchBundlePaths = bundleRelPaths.slice(startIdx, endIdx);

        for (const bundleRelPath of batchBundlePaths) {
          if (!isRunning.value) break;
          const bundleTasks = tasksByBundle.get(bundleRelPath)!;

          // 加载这个 bundle
          const file = bundleFileMap.get(bundleRelPath);
          if (!file) {
            for (const t of bundleTasks) {
              const lt = localTasks.find(x => x === t || (x.bundleRelPath === t.bundleRelPath && x.pathId === t.pathId));
              if (lt) {
                lt.status = 'error';
                lt.error = `找不到 bundle 文件：${bundleRelPath}`;
              }
            }
            globalIdx += bundleTasks.length;
            totalProgress.value = globalIdx / total;
            continue;
          }

          stageText.value = `[批次 ${bi + 1}/${totalBatches}] [${globalIdx + 1}/${total}] ${bundleRelPath}`;
          let infos: Awaited<ReturnType<typeof assetManager.loadSingleBundleSilently>>;
          try {
            infos = await assetManager.loadSingleBundleSilently(file);
          } catch (e) {
            for (const t of bundleTasks) {
              const lt = localTasks.find(x => x.bundleRelPath === t.bundleRelPath && x.pathId === t.pathId);
              if (lt) {
                lt.status = 'error';
                lt.error = `加载失败：${String(e)}`;
              }
            }
            globalIdx += bundleTasks.length;
            totalProgress.value = globalIdx / total;
            continue;
          }

          // 构建 pathId → info 映射
          const infoByPathId = new Map(infos.map(i => [i.pathId, i]));

          for (const t of bundleTasks) {
            if (!isRunning.value) break;
            const lt = localTasks.find(x => x.bundleRelPath === t.bundleRelPath && x.pathId === t.pathId);
            if (!lt) continue;

            try {
              lt.status = 'exporting';
              const info = infoByPathId.get(t.pathId);
              if (!info) throw new Error(`bundle 内找不到 pathId=${t.pathId}`);

              // 跨 bundle 去重：同名自动加序号
              let customName = t.exportFileName.replace(/\.png$/i, '');

              // 可选：在文件名中加入 bundle 资产文件名
              if (includeBundleName.value) {
                const bundleBaseName = t.bundleRelPath.includes('/')
                  ? t.bundleRelPath.slice(t.bundleRelPath.lastIndexOf('/') + 1)
                  : t.bundleRelPath;
                const bundleNameNoExt = bundleBaseName.replace(/\.(?:assetbundle|ab)$/i, '');
                if (bundleNameNoExt && !customName.endsWith(`_${bundleNameNoExt}`)) {
                  customName = `${customName}_${bundleNameNoExt}`;
                }
              }

              const count = globalRenameMap.get(customName) || 0;
              if (count > 0) {
                customName = `${customName} (${count})`;
              }
              globalRenameMap.set(t.exportFileName.replace(/\.png$/i, ''), (globalRenameMap.get(t.exportFileName.replace(/\.png$/i, '')) || 0) + 1);

              lt.status = 'writing';
              const result = await assetManager.exportTextureToDir(
                info.fileId,
                info.pathId,
                outDir,
                customName,
              );
              if (result && result.success > 0) {
                lt.status = 'done';
                totalExported++;
              } else {
                lt.status = 'error';
                lt.error = '导出返回 0 成功';
              }
            } catch (e) {
              lt.status = 'error';
              lt.error = String(e);
              console.error(`[BatchWorkflow] filter task (${t.bundleRelPath} :: ${t.textureName}) failed:`, e);
            }
            globalIdx++;
            totalProgress.value = globalIdx / total;
          }

          // 同时导出原始 bundle 文件到输出目录
          if (exportOriginalBundle.value) {
            try {
              const bundleFileName = bundleRelPath.includes('/')
                ? bundleRelPath.slice(bundleRelPath.lastIndexOf('/') + 1)
                : bundleRelPath;
              const fileHandle = await outDir.getFileHandle(bundleFileName, { create: true });
              const writable = await fileHandle.createWritable();
              await writable.write(file);
              await writable.close();
            } catch (e) {
              console.error(`[BatchWorkflow] copy original bundle failed: ${bundleRelPath}`, e);
            }
          }

          // 清理 worker 内存（每个 bundle 处理完后）
          try {
            await assetManager.clearFiles();
          } catch {
            // 忽略
          }
        }

        // 批次结束触发响应式更新 + 让出主线程
        filterResolutionTasks.value = [...localTasks];
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }

      filterResolutionTasks.value = [...localTasks];
      stageText.value = isRunning.value
        ? `筛选导出完成：共导出 ${totalExported} 个纹理`
        : `已取消：共导出 ${totalExported} 个纹理`;
    } finally {
      isRunning.value = false;
      currentTaskIndex.value = -1;
      currentBatchIndex.value = -1;
      try {
        await assetManager.clearFiles();
      } catch {
        // 忽略
      }
    }
  };

  /**
   * 遍历 tasks 执行批量处理：读图 → 抠图 → 编码写入纹理 → 加密导出 → 写回同目录
   * 输出与菜单"导出修改后"一致：KH 加密格式 + _modified 文件名后缀
   */
  const run = async () => {
    if (isRunning.value) return;
    if (!tasks.value.length) {
      ElMessage({ message: '没有可执行的任务，请先预览匹配', type: 'warning' });
      return;
    }
    if (enableRemoveBg.value && !activeBgRemoval.value.isModelReady.value) {
      ElMessage({ message: 'AI 抠图已启用但模型未就绪，请先初始化模型', type: 'warning' });
      return;
    }

    // 预请求所有涉及目录的 readwrite 权限（必须在用户激活上下文中调用）
    // 否则循环中 requestPermission() 会因丢失用户激活而抛 SecurityError
    const uniqueDirs = new Set<FileSystemDirectoryHandle>();
    for (const [, handle] of bundleDirHandleByPath) uniqueDirs.add(handle);
    for (const task of tasks.value) {
      const basePath = bundleFileToBaseDir.get(task.bundleFileName) || '';
      const handle = bundleDirHandleByPath.get(basePath);
      if (handle) uniqueDirs.add(handle);
    }
    for (const dir of uniqueDirs) {
      if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        const result = await dir.requestPermission({ mode: 'readwrite' });
        if (result !== 'granted') {
          ElMessage({ message: '目录权限被拒绝，无法写入文件', type: 'error' });
          return;
        }
      }
    }

    isRunning.value = true;
    const total = tasks.value.length;

    // bundleFileName → fileId（md5），从 assetInfos 一次性构建
    const fileNameToFileId = new Map<string, string>();
    for (const info of assetManager.assetInfos) {
      if (!fileNameToFileId.has(info.fileName)) {
        fileNameToFileId.set(info.fileName, info.fileId);
      }
    }

    // (bundleFileName, pathId) → 原始纹理尺寸，用于自适应缩放
    const textureDimMap = new Map<string, { width: number; height: number }>();
    for (const info of assetManager.assetInfos) {
      const preview = info.preview as { width?: number; height?: number };
      if (preview?.width && preview?.height) {
        textureDimMap.set(`${info.fileName}|${info.pathId}`, { width: preview.width, height: preview.height });
      }
    }

    try {
      for (let i = 0; i < total; i++) {
        if (!isRunning.value) break;
        const task = tasks.value[i];
        currentTaskIndex.value = i;

        try {
          // a. 读取图片（用 basePath + imageName 构造完整路径查找）
          task.status = 'loading';
          stageText.value = `[${i + 1}/${total}] 正在读取图片：${task.imageName}`;
          const imgBasePath = bundleFileToBaseDir.get(task.bundleFileName) || '';
          const imgFullPath = imgBasePath ? `${imgBasePath}/${task.imageName}` : task.imageName;
          const file = imageFileMap.get(imgFullPath);
          if (!file) throw new Error(`找不到图片文件：${imgFullPath}`);
          const bitmap = await createImageBitmap(file);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法获取 canvas 2d 上下文');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

          // b. 可选 AI 抠图
          if (enableRemoveBg.value) {
            task.status = 'removebg';
            stageText.value = `[${i + 1}/${total}] 正在抠图：${task.imageName}`;
            imageData = await activeBgRemoval.value.removeBackground(imageData, {
              threshold: removeBgThreshold.value,
              feather: removeBgFeather.value,
              maxProcessSize: removeBgMaxSize.value,
            });
          }

          // b1. 裁剪：通用裁剪（所有图）或兜底裁剪（比例差大且含 Portrait 关键词）
          // 方向由 fallbackCropDirection 控制：bottom=保留顶部裁下方 / top=保留底部裁上方 / center=居中裁上下
          const cropDimKey = `${task.bundleFileName}|${task.pathId}`;
          const cropOrigDims = textureDimMap.get(cropDimKey);
          const imgRatio = imageData.width / imageData.height;
          const texRatio = cropOrigDims ? cropOrigDims.width / cropOrigDims.height : imgRatio;
          const ratioDiff = Math.abs(imgRatio - texRatio);
          const hasPortrait = /portrait/i.test(task.textureName) || /portrait/i.test(task.imageName);
          const needCrop =
            universalCrop.value ||
            (task.isFallback && ratioDiff > 0.1 && hasPortrait);
          if (needCrop && fallbackCropRatio.value > 0) {
            const keepRatio = 1 - fallbackCropRatio.value;
            const cropH = Math.max(1, Math.floor(imageData.height * keepRatio));
            const offsetY =
              fallbackCropDirection.value === 'top'
                ? imageData.height - cropH
                : fallbackCropDirection.value === 'center'
                  ? Math.floor((imageData.height - cropH) / 2)
                  : 0;
            // 用数组切片截取 [offsetY, offsetY+cropH) 区域——不依赖 putImageData 的
            // dirty 参数语义（部分 canvas 实现下 dirty 行为不一致会导致 top/center 错乱），
            // 纯内存操作，方向必然正确。
            const rowBytes = imageData.width * 4;
            const outData = new Uint8ClampedArray(rowBytes * cropH);
            for (let r = 0; r < cropH; r++) {
              outData.set(
                imageData.data.subarray((offsetY + r) * rowBytes, (offsetY + r + 1) * rowBytes),
                r * rowBytes,
              );
            }
            console.info(
              `[batch-crop] ${task.imageName} dir=${fallbackCropDirection.value} ratio=${fallbackCropRatio.value} h=${imageData.height} cropH=${cropH} offsetY=${offsetY}`,
            );
            imageData = new ImageData(outData, imageData.width, cropH);
          }

          // c. 自适应大小：缩放图片到原始纹理尺寸（contain 等比填充）
          const dimKey = `${task.bundleFileName}|${task.pathId}`;
          const origDims = textureDimMap.get(dimKey);
          if (origDims && (imageData.width !== origDims.width || imageData.height !== origDims.height)) {
            const srcCanvas = new OffscreenCanvas(imageData.width, imageData.height);
            const srcCtx = srcCanvas.getContext('2d')!;
            srcCtx.putImageData(imageData, 0, 0);

            const dstCanvas = new OffscreenCanvas(origDims.width, origDims.height);
            const dstCtx = dstCanvas.getContext('2d')!;
            dstCtx.imageSmoothingEnabled = true;
            dstCtx.imageSmoothingQuality = 'high';

            // contain 模式：等比缩放，居中，空白透明
            const scale = Math.min(origDims.width / imageData.width, origDims.height / imageData.height);
            const dw = Math.round(imageData.width * scale);
            const dh = Math.round(imageData.height * scale);
            const dx = Math.round((origDims.width - dw) / 2);
            const dy = Math.round((origDims.height - dh) / 2);

            dstCtx.drawImage(srcCanvas, 0, 0, imageData.width, imageData.height, dx, dy, dw, dh);
            imageData = dstCtx.getImageData(0, 0, origDims.width, origDims.height);
          }

          // d. 编码纹理写入 worker
          task.status = 'encoding';
          stageText.value = `[${i + 1}/${total}] 正在编码纹理：${task.textureName}`;
          const fileId = fileNameToFileId.get(task.bundleFileName);
          if (!fileId) throw new Error(`找不到 bundle 对应的 fileId：${task.bundleFileName}`);

          const w = imageData.width;
          const h = imageData.height;
          const rgba = new Uint8Array(imageData.data.length);
          rgba.set(imageData.data);

          const targetFmt = targetFormat.value === -1 ? undefined : (targetFormat.value as TextureFormat);
          const ok = await assetManager.modifyTexture2D(
            fileId,
            task.pathId,
            rgba,
            w,
            h,
            targetFmt,
            generateMips.value,
          );
          if (!ok) throw new Error('modifyTexture2D 返回 false');

          // e. 拿到加密后的 bundle buffer（与菜单"导出修改后"一致：KH 加密 + _modified 后缀）
          task.status = 'writing';
          stageText.value = `[${i + 1}/${total}] 正在写入：${task.bundleFileName}`;
          const buffer = await assetManager.getModifiedBundleEncrypted(fileId);
          if (!buffer) throw new Error('getModifiedBundleEncrypted 返回空');

          // 构建输出文件名：添加 _modified 后缀（与菜单"导出修改后"一致）
          const dot = task.bundleFileName.lastIndexOf('.');
          const outName = dot > 0
            ? `${task.bundleFileName.slice(0, dot)}_modified${task.bundleFileName.slice(dot)}`
            : `${task.bundleFileName}_modified`;

          // 写入 bundle 所在目录（同一目录）
          const basePath = bundleFileToBaseDir.get(task.bundleFileName) || '';
          const dirHandle = bundleDirHandleByPath.get(basePath);
          if (!dirHandle) throw new Error(`找不到 bundle 所在目录：${task.bundleFileName}`);
          // 权限已在 run() 开始时预请求，无需在循环中再次请求

          const fileHandle = await dirHandle.getFileHandle(outName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(buffer);
          await writable.close();

          task.status = 'done';
        } catch (e) {
          task.status = 'error';
          task.error = String(e);
          console.error(`[BatchWorkflow] task ${i} (${task.imageName}) failed:`, e);
        }
        totalProgress.value = (i + 1) / total;
      }
      stageText.value = isRunning.value ? '批量处理完成' : '已取消';
    } finally {
      isRunning.value = false;
      currentTaskIndex.value = -1;
    }
  };

  const cancel = () => {
    isRunning.value = false;
  };

  // === 资产匹配复制模式 ===

  const setAssetMatchSearchDir = (handle: FileSystemDirectoryHandle | null) => {
    assetMatchSearchDirHandle.value = handle;
  };

  /** 去掉文件名结尾的 _宽x高 后缀（如 abc_100x100 → abc） */
  const stripDimensionSuffix = (name: string): string => {
    return name.replace(/_\d+x\d+$/, '');
  };

  /** 预览扫描：扫描输入文件夹的图片，在资产库目录中递归查找同名 PNG，定位所在文件夹 */
  const previewAssetMatch = async () => {
    const srcDir = inputDirHandle.value;
    const searchDir = assetMatchSearchDirHandle.value;
    if (!srcDir) {
      ElMessage({ message: '请先选择输入目录（来源图片）', type: 'warning' });
      return;
    }
    if (!searchDir) {
      ElMessage({ message: '请先选择资产库目录', type: 'warning' });
      return;
    }

    isRunning.value = true;
    stageText.value = '正在扫描输入目录中的图片...';
    assetMatchTasks.value = [];
    assetMatchUnmatched.value = [];
    assetMatchFolderHandles.clear();
    assetMatchSourceDirHandles.clear();

    try {
      // 递归扫描输入目录中的图片
      const perm = await srcDir.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        const req = await srcDir.requestPermission({ mode: 'read' });
        if (req !== 'granted') {
          ElMessage({ message: '没有输入目录的读取权限', type: 'error' });
          return;
        }
      }
      const sourceImages: Array<{ name: string; dirHandle: FileSystemDirectoryHandle }> = [];
      const scanInputImages = async (handle: FileSystemDirectoryHandle) => {
        const p = await handle.queryPermission({ mode: 'read' });
        if (p !== 'granted') {
          const r = await handle.requestPermission({ mode: 'read' });
          if (r !== 'granted') return;
        }
        for await (const [name, entry] of (handle as any).entries()) {
          if (entry.kind === 'file' && IMAGE_EXT_RE.test(name)) {
            sourceImages.push({ name, dirHandle: handle });
          } else if (entry.kind === 'directory') {
            await scanInputImages(entry as FileSystemDirectoryHandle);
          }
        }
      };
      await scanInputImages(srcDir);

      if (!sourceImages.length) {
        ElMessage({ message: '输入目录中未找到图片文件', type: 'warning' });
        return;
      }

      stageText.value = '正在递归扫描资产库目录中的图片...';
      // 递归扫描资产库目录中的图片，建立「去维度后缀名 → { 文件名, 所在目录 handle, 目录名 }」映射
      const extRe = /\.[^.]+$/;
      const imageLocationMap = new Map<string, { fileName: string; dirHandle: FileSystemDirectoryHandle; dirName: string }>();

      const scanForImages = async (handle: FileSystemDirectoryHandle, dirName: string) => {
        const p = await handle.queryPermission({ mode: 'read' });
        if (p !== 'granted') {
          const r = await handle.requestPermission({ mode: 'read' });
          if (r !== 'granted') return;
        }
        for await (const [name, entry] of (handle as any).entries()) {
          if (entry.kind === 'file' && IMAGE_EXT_RE.test(name)) {
            const baseName = name.replace(extRe, '');
            const matchKey = stripDimensionSuffix(baseName);
            // 只记录第一次出现的位置
            if (!imageLocationMap.has(matchKey)) {
              imageLocationMap.set(matchKey, { fileName: name, dirHandle: handle, dirName });
            }
          } else if (entry.kind === 'directory') {
            await scanForImages(entry as FileSystemDirectoryHandle, name);
          }
        }
      };
      await scanForImages(searchDir, searchDir.name);

      // 匹配并扫描每个匹配文件夹中的 .assetbundle 文件
      stageText.value = '正在匹配并扫描资产文件...';
      const tasks: AssetMatchTaskItem[] = [];
      const unmatched: string[] = [];

      for (const { name: srcName, dirHandle: srcDirHandle } of sourceImages) {
        const srcBase = srcName.replace(extRe, '');
        const matchKey = stripDimensionSuffix(srcBase);
        const location = imageLocationMap.get(matchKey);
        if (!location) {
          unmatched.push(srcName);
          continue;
        }

        // 扫描该文件夹中的 .assetbundle 文件
        const bundleFiles: string[] = [];
        try {
          const p = await location.dirHandle.queryPermission({ mode: 'read' });
          if (p !== 'granted') {
            await location.dirHandle.requestPermission({ mode: 'read' });
          }
          for await (const [name, entry] of (location.dirHandle as any).entries()) {
            if (entry.kind === 'file' && BUNDLE_EXT_RE.test(name)) {
              bundleFiles.push(name);
            }
          }
        } catch {
          // 忽略扫描错误
        }

        const taskIndex = tasks.length;
        tasks.push({
          sourceFileName: srcName,
          matchedFolderName: location.dirName,
          matchedImageName: location.fileName,
          bundleFiles,
          bundleCount: bundleFiles.length,
          status: 'pending',
        });
        assetMatchFolderHandles.set(taskIndex, location.dirHandle);
        assetMatchSourceDirHandles.set(taskIndex, srcDirHandle);
      }

      assetMatchTasks.value = tasks;
      assetMatchUnmatched.value = unmatched;
      const totalBundles = tasks.reduce((sum, t) => sum + t.bundleCount, 0);
      stageText.value = `扫描完成：${tasks.length} 个匹配（共 ${totalBundles} 个资产文件），${unmatched.length} 个未匹配`;
    } finally {
      isRunning.value = false;
    }
  };

  /** 执行复制：将匹配到的文件夹中的所有 .assetbundle 复制到来源图片所在目录 */
  const runAssetMatchCopy = async () => {
    if (!inputDirHandle.value) {
      ElMessage({ message: '请先选择输入目录', type: 'warning' });
      return;
    }
    if (!assetMatchTasks.value.length) {
      ElMessage({ message: '没有可执行的任务，请先预览扫描', type: 'warning' });
      return;
    }

    // 预请求所有涉及目录的权限（必须在用户激活上下文中调用）
    const uniqueReadDirs = new Set<FileSystemDirectoryHandle>();
    const uniqueWriteDirs = new Set<FileSystemDirectoryHandle>();
    for (let i = 0; i < assetMatchTasks.value.length; i++) {
      const srcDir = assetMatchFolderHandles.get(i);
      const outDir = assetMatchSourceDirHandles.get(i);
      if (srcDir) uniqueReadDirs.add(srcDir);
      if (outDir) uniqueWriteDirs.add(outDir);
    }
    for (const dir of uniqueReadDirs) {
      if ((await dir.queryPermission({ mode: 'read' })) !== 'granted') {
        await dir.requestPermission({ mode: 'read' });
      }
    }
    for (const dir of uniqueWriteDirs) {
      if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        const result = await dir.requestPermission({ mode: 'readwrite' });
        if (result !== 'granted') {
          ElMessage({ message: '目录权限被拒绝，无法写入文件', type: 'error' });
          return;
        }
      }
    }

    isRunning.value = true;
    const tasks = assetMatchTasks.value;
    const total = tasks.length;
    // 记录已处理的文件夹，避免重复复制（多张图片可能匹配到同一资产文件夹）
    const processedFolders = new Set<FileSystemDirectoryHandle>();
    let skipCount = 0;

    try {
      for (let i = 0; i < total; i++) {
        if (!isRunning.value) break;
        const task = tasks[i];
        const srcDir = assetMatchFolderHandles.get(i);
        const outDir = assetMatchSourceDirHandles.get(i);

        // 如果该资产文件夹已经被处理过（另一张图片也匹配到同一文件夹），跳过
        if (!srcDir || !outDir || processedFolders.has(srcDir)) {
          task.status = 'skipped';
          skipCount++;
          totalProgress.value = (i + 1) / total;
          currentTaskIndex.value = i;
          continue;
        }

        task.status = 'copying';
        stageText.value = `[${i + 1}/${total}] 正在复制 ${task.matchedFolderName} 中的 ${task.bundleCount} 个资产文件`;

        try {
          // 权限已在 runAssetMatchCopy() 开始时预请求

          for await (const [name, entry] of (srcDir as any).entries()) {
            if (entry.kind === 'file' && BUNDLE_EXT_RE.test(name)) {
              const file = await entry.getFile();
              const outFileHandle = await outDir.getFileHandle(name, { create: true });
              const writable = await outFileHandle.createWritable();
              await writable.write(file);
              await writable.close();
            }
          }
          processedFolders.add(srcDir);
          task.status = 'done';
        } catch (e) {
          task.status = 'error';
          task.error = String(e);
          console.error(`[BatchWorkflow] assetMatch task ${i} (${task.matchedFolderName}) failed:`, e);
        }

        totalProgress.value = (i + 1) / total;
        currentTaskIndex.value = i;
      }
      assetMatchSkipCount.value = skipCount;
      stageText.value = isRunning.value ? (skipCount > 0 ? `复制完成（${skipCount} 个文件夹因重复跳过）` : '复制完成') : '已取消';
    } finally {
      isRunning.value = false;
      currentTaskIndex.value = -1;
    }
  };

  // === 图片匹配复制模式 ===

  const setImageMatchSearchDir = (handle: FileSystemDirectoryHandle | null) => {
    imageMatchSearchDirHandle.value = handle;
  };

  const setImageMatchOutputDir = (handle: FileSystemDirectoryHandle | null) => {
    imageMatchOutputDirHandle.value = handle;
  };

  /** 递归扫描目录下所有图片文件，返回文件名（含扩展名）→ File 的 Map */
  const scanImagesRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    basePath = '',
  ): Promise<Map<string, File>> => {
    const result = new Map<string, File>();
    // 检查权限
    const perm = await dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const req = await dirHandle.requestPermission({ mode: 'read' });
      if (req !== 'granted') return result;
    }
    for await (const [name, entry] of (dirHandle as any).entries()) {
      if (entry.kind === 'file' && IMAGE_EXT_RE.test(name)) {
        result.set(name, await entry.getFile());
      } else if (entry.kind === 'directory') {
        // 只递归一层，不深层递归（搜索目录通常较平）
        const sub = await scanImagesRecursive(entry, name + '/');
        for (const [k, v] of sub) {
          result.set(k, v);
        }
      }
    }
    return result;
  };

  /** 预览扫描：扫描输入文件夹的图片，在搜索目录中匹配同名图片 */
  const previewImageMatch = async () => {
    const srcDir = inputDirHandle.value;
    const searchDir = imageMatchSearchDirHandle.value;
    if (!srcDir) {
      ElMessage({ message: '请先选择输入目录（来源图片）', type: 'warning' });
      return;
    }
    if (!searchDir) {
      ElMessage({ message: '请先选择搜索目录', type: 'warning' });
      return;
    }

    isRunning.value = true;
    stageText.value = '正在扫描输入目录中的图片...';
    imageMatchTasks.value = [];
    imageMatchUnmatched.value = [];

    try {
      // 扫描输入目录中的图片（只扫描一层，不递归）
      const perm = await srcDir.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        const req = await srcDir.requestPermission({ mode: 'read' });
        if (req !== 'granted') {
          ElMessage({ message: '没有输入目录的读取权限', type: 'error' });
          return;
        }
      }
      const sourceImages: Array<{ name: string; file: File }> = [];
      for await (const [name, entry] of (srcDir as any).entries()) {
        if (entry.kind === 'file' && IMAGE_EXT_RE.test(name)) {
          sourceImages.push({ name, file: await entry.getFile() });
        }
      }

      if (!sourceImages.length) {
        ElMessage({ message: '输入目录中未找到图片文件', type: 'warning' });
        return;
      }

      stageText.value = `正在扫描搜索目录中的图片...`;
      // 扫描搜索目录中的图片，建立「去扩展名 → 文件名」映射
      const searchImages = await scanImagesRecursive(searchDir);
      const searchNameMap = new Map<string, string>(); // 去扩展名 → 文件名（含扩展名）
      for (const [fileName] of searchImages) {
        const baseName = fileName.replace(/\.[^.]+$/, '');
        searchNameMap.set(baseName, fileName);
      }

      // 匹配
      const suffix = imageMatchSuffix.value;
      const matchOptions: MatchOptions = {
        mode: imageMatchMode.value,
        caseInsensitive: imageMatchCaseInsensitive.value,
        regexPattern: imageMatchMode.value === 'regex' ? imageMatchRegexPattern.value : undefined,
      };
      const tasks: ImageMatchTaskItem[] = [];
      const unmatched: string[] = [];
      const extRe = /\.[^.]+$/;

      for (const { name: srcName } of sourceImages) {
        const srcBase = srcName.replace(extRe, '');
        // 使用增强匹配模式
        let matched = searchNameMap.get(srcBase);
        if (!matched) {
          for (const [searchBase, searchFileName] of searchNameMap) {
            if (matchName(srcName, searchBase, matchOptions)) {
              matched = searchFileName;
              break;
            }
          }
        }
        if (matched) {
          const matchedExt = matched.match(extRe)?.[0] || '.png';
          const outputName = `${srcBase}${suffix}${matchedExt}`;
          tasks.push({
            imageName: srcBase,
            sourceFileName: srcName,
            matchedFileName: matched,
            outputFileName: outputName,
            status: 'pending',
          });
        } else {
          unmatched.push(srcName);
        }
      }

      imageMatchTasks.value = tasks;
      imageMatchUnmatched.value = unmatched;
      stageText.value = `扫描完成：${tasks.length} 个匹配，${unmatched.length} 个未匹配`;
    } finally {
      isRunning.value = false;
    }
  };

  /** 执行复制：将搜索目录中匹配的图片复制到输出目录，加后缀重命名 */
  const runImageMatch = async () => {
    const searchDir = imageMatchSearchDirHandle.value;
    const outDir = imageMatchOutputDirHandle.value;
    if (!searchDir) {
      ElMessage({ message: '请先选择搜索目录', type: 'warning' });
      return;
    }
    if (!outDir) {
      ElMessage({ message: '请先选择输出目录', type: 'warning' });
      return;
    }
    if (!imageMatchTasks.value.length) {
      ElMessage({ message: '没有可执行的任务，请先预览扫描', type: 'warning' });
      return;
    }

    // 预请求搜索目录读取权限和输出目录写入权限（必须在用户激活上下文中调用）
    if ((await searchDir.queryPermission({ mode: 'read' })) !== 'granted') {
      await searchDir.requestPermission({ mode: 'read' });
    }
    let perm = await outDir.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await outDir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        ElMessage({ message: '没有输出目录的写入权限', type: 'error' });
        return;
      }
    }

    isRunning.value = true;
    const tasks = imageMatchTasks.value;
    const total = tasks.length;

    // 搜索目录中图片的 File 缓存（避免重复遍历目录）
    const searchFileMap = await scanImagesRecursive(searchDir);

    try {
      for (let i = 0; i < total; i++) {
        if (!isRunning.value) break;
        const task = tasks[i];

        task.status = 'copying';
        stageText.value = `[${i + 1}/${total}] 正在复制 ${task.matchedFileName} → ${task.outputFileName}`;

        try {
          const srcFile = searchFileMap.get(task.matchedFileName);
          if (!srcFile) {
            throw new Error(`在搜索目录中找不到文件：${task.matchedFileName}`);
          }

          const outFileHandle = await outDir.getFileHandle(task.outputFileName, { create: true });
          const writable = await outFileHandle.createWritable();
          await writable.write(srcFile);
          await writable.close();

          task.status = 'done';
        } catch (e) {
          task.status = 'error';
          task.error = String(e);
          console.error(`[BatchWorkflow] imageMatch task ${i} (${task.matchedFileName}) failed:`, e);
        }

        totalProgress.value = (i + 1) / total;
        currentTaskIndex.value = i;
      }
      stageText.value = isRunning.value ? '复制完成' : '已取消';
    } finally {
      isRunning.value = false;
      currentTaskIndex.value = -1;
    }
  };

  const reset = () => {
    if (isRunning.value) return;
    inputDirHandle.value = null;
    outputDirHandle.value = null;
    enableRemoveBg.value = false;
    targetFormat.value = TextureFormat.RGBA32;
    generateMips.value = false;
    removeBgThreshold.value = 128;
    removeBgFeather.value = true;
    removeBgMaxSize.value = 1024;
    fallbackCropRatio.value = 0.13;
    fallbackCropDirection.value = 'bottom';
    universalCrop.value = false;
    includeBundleName.value = false;
    tasks.value = [];
    exportTextureTasks.value = [];
    filterResolutionTasks.value = [];
    filterResolutions.value = [];
    filterTextureNames.value = [];
    filterLogic.value = 'and';
    filterNameMatchMode.value = 'contains';
    filterNameCaseInsensitive.value = true;
    filterOutputDirHandle.value = null;
    exportOriginalBundle.value = true;
    imageMatchSearchDirHandle.value = null;
    imageMatchOutputDirHandle.value = null;
    imageMatchSuffix.value = '_copied';
    imageMatchMode.value = 'exact';
    imageMatchCaseInsensitive.value = false;
    imageMatchRegexPattern.value = '';
    imageMatchTasks.value = [];
    imageMatchUnmatched.value = [];
    assetMatchSearchDirHandle.value = null;
    assetMatchTasks.value = [];
    assetMatchUnmatched.value = [];
    assetMatchSkipCount.value = 0;
    assetMatchFolderHandles.clear();
    assetMatchSourceDirHandles.clear();
    matchedResults.value = [];
    unmatchedImages.value = [];
    unmatchedTextures.value = [];
    totalProgress.value = 0;
    stageText.value = '';
    currentTaskIndex.value = -1;
    currentBatchIndex.value = -1;
    totalBatchCount.value = 0;
    imageFileMap.clear();
    bundleDirHandleMap.clear();
    bundleFileHandleMap.clear();
    bundleFileMap.clear();
    bundleFileToBaseDir.clear();
    bundleDirHandleByPath.clear();
  };

  return {
    // state
    inputDirHandle,
    outputDirHandle,
    enableRemoveBg,
    targetFormat,
    generateMips,
    removeBgThreshold,
    removeBgFeather,
    removeBgMaxSize,
    fallbackCropRatio,
    fallbackCropDirection,
    universalCrop,
    batchSize,
    matchSuffix,
    includeBundleName,
    tasks,
    exportTextureTasks,
    filterResolutionTasks,
    filterResolutions,
    filterTextureNames,
    filterLogic,
    filterNameMatchMode,
    filterNameCaseInsensitive,
    filterOutputDirHandle,
    exportOriginalBundle,
    imageMatchSearchDirHandle,
    imageMatchOutputDirHandle,
    imageMatchSuffix,
    imageMatchMode,
    imageMatchCaseInsensitive,
    imageMatchRegexPattern,
    assetMatchSkipCount,
    imageMatchTasks,
    imageMatchUnmatched,
    assetMatchSearchDirHandle,
    assetMatchTasks,
    assetMatchUnmatched,
    mode,
    isRunning,
    currentTaskIndex,
    currentBatchIndex,
    totalBatchCount,
    totalProgress,
    stageText,
    matchedResults,
    unmatchedImages,
    unmatchedTextures,
    // 抠图模型选择（'onnx' = RMBG-1.4, 'tfjs' = Removebg 1.6, 'fast' = Removebg 1.5 Fast）
    removeBgModelType,
    // 抠图模型状态（透传当前激活的 composable，随模型切换自动响应）
    isModelReady: computed(() => activeBgRemoval.value.isModelReady.value),
    modelLoadProgress: computed(() => activeBgRemoval.value.modelLoadProgress.value),
    isProcessing: computed(() => activeBgRemoval.value.isProcessing.value),
    currentStage: computed(() => activeBgRemoval.value.currentStage.value),
    // actions
    setInputDir,
    setOutputDir,
    setFilterOutputDir,
    addResolution,
    removeResolution,
    clearResolutions,
    parseResolution,
    addTextureName,
    removeTextureName,
    clearTextureNames,
    setFilterLogic,
    initRemoveBgModel,
    previewMatch,
    run,
    previewExportTextures,
    runExportTextures,
    previewFilterByResolution,
    runFilterByResolution,
    setImageMatchSearchDir,
    setImageMatchOutputDir,
    previewImageMatch,
    runImageMatch,
    setAssetMatchSearchDir,
    previewAssetMatch,
    runAssetMatchCopy,
    cancel,
    reset,
  };
});
