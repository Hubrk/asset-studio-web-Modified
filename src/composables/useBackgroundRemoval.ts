import * as ort from 'onnxruntime-web';
import {
  RMBG_MODEL,
  hasModel,
  getModel,
  fetchAndCacheModel,
} from '@/utils/onnxModelCache';

// 设置 onnxruntime-web 的 wasm 文件加载路径（dev 模式下 Vite 会服务 node_modules）
ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
// 单线程：项目未配置 COOP/COEP，SharedArrayBuffer 不可用，多线程会失败
ort.env.wasm.numThreads = 1;

/**
 * 抠图选项
 */
export interface RemoveBgOptions {
  /** 二值化阈值，mask < threshold → alpha=0，默认 128。softAlpha=true 时此项作为下限截断 */
  threshold?: number;
  /** 是否启用边缘羽化（3x3 高斯模糊），默认 true */
  feather?: boolean;
  /** 最大处理尺寸（RMBG-1.4 固定 1024×1024 输入），默认 1024 */
  maxProcessSize?: number;
  /**
   * 软 alpha 模式：保留 mask 连续值作为 alpha（0-255），不做硬二值化。
   * 让边缘自然过渡，避免大面积色块残留。默认 true。
   * threshold 仍作为下限截断：mask < threshold → alpha=0
   */
  softAlpha?: boolean;
  /**
   * 强制移除指定颜色背景（色度键）。
   * 对 RMBG 抠不干净的纯色背景（如白底）兜底：RGB 距离 ≤ tolerance 的像素 alpha=0。
   */
  forceRemoveColor?: { r: number; g: number; b: number; tolerance: number };
}

/**
 * 抠图处理阶段与进度
 */
export interface RemoveBgProgress {
  stage: 'loading-model' | 'preprocessing' | 'inference' | 'postprocessing' | 'done';
  progress: number; // 0-1
}

/**
 * useBackgroundRemoval 返回值
 */
export interface UseBackgroundRemovalReturn {
  /** 模型是否已加载就绪 */
  isModelReady: Ref<boolean>;
  /** 模型加载进度 0-1 */
  modelLoadProgress: Ref<number>;
  /** 是否正在处理 */
  isProcessing: Ref<boolean>;
  /** 当前处理阶段 */
  currentStage: Ref<string>;
  /** 初始化：下载并加载模型到内存 */
  init: () => Promise<void>;
  /** 抠图：输入 ImageData，返回带 alpha 的 ImageData */
  removeBackground: (imageData: ImageData, options?: RemoveBgOptions) => Promise<ImageData>;
}

/**
 * 缩放 ImageData 到目标尺寸（使用 canvas 双线性插值）
 * @param src 源 ImageData
 * @param targetW 目标宽度
 * @param targetH 目标高度
 * @returns 缩放后的 ImageData
 */
function resizeImageData(src: ImageData, targetW: number, targetH: number): ImageData {
  // 优先使用 OffscreenCanvas
  if (typeof OffscreenCanvas !== 'undefined') {
    const srcCanvas = new OffscreenCanvas(src.width, src.height);
    const srcCtx = srcCanvas.getContext('2d');
    if (srcCtx) {
      srcCtx.putImageData(src, 0, 0);
      const dstCanvas = new OffscreenCanvas(targetW, targetH);
      const dstCtx = dstCanvas.getContext('2d');
      if (dstCtx) {
        dstCtx.imageSmoothingEnabled = true;
        dstCtx.imageSmoothingQuality = 'high';
        dstCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
        return dstCtx.getImageData(0, 0, targetW, targetH);
      }
    }
  }
  // 回退到普通 canvas
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = src.width;
  srcCanvas.height = src.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('无法创建 canvas 2d 上下文');
  srcCtx.putImageData(src, 0, 0);
  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = targetW;
  dstCanvas.height = targetH;
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) throw new Error('无法创建 canvas 2d 上下文');
  dstCtx.imageSmoothingEnabled = true;
  dstCtx.imageSmoothingQuality = 'high';
  dstCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
  return dstCtx.getImageData(0, 0, targetW, targetH);
}

/**
 * 把 mask 应用为 ImageData 的 alpha 通道（RGB 保留自源数据）
 * @param rgba 源 RGBA ImageData
 * @param mask mask 数据（长度需等于 width * height）
 * @returns 新的 ImageData，RGB 来自源，alpha 来自 mask
 */
function applyAlphaToImageData(rgba: ImageData, mask: Uint8ClampedArray): ImageData {
  const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height);
  const data = out.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    data[i + 3] = mask[p];
  }
  return out;
}

/**
 * 对 mask 做一次 3x3 box blur（用于边缘羽化）
 * @param mask 输入 mask
 * @param width 宽度
 * @param height 高度
 * @returns 模糊后的 mask
 */
function boxBlur3x3(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      // 遍历 3x3 邻域
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            sum += mask[ny * width + nx];
            count++;
          }
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * 模块级共享状态（singleton）
 * 让 TextureEditor / BatchWorkflow 等多个调用方共享同一个模型 session，
 * 避免每次调用 useBackgroundRemoval() 都重复加载模型到内存。
 */
const sharedSession = shallowRef<ort.InferenceSession | null>(null);
const sharedIsModelReady = ref(false);
const sharedModelLoadProgress = ref(0);
const sharedIsProcessing = ref(false);
const sharedCurrentStage = ref<string>('');
// 防止并发 init：多个组件同时点击"初始化模型"时，只真正加载一次
let initPromise: Promise<void> | null = null;

/**
 * RMBG-1.4 背景移除 composable
 * 返回共享状态，所有调用方共享同一个 session。
 */
export function useBackgroundRemoval(): UseBackgroundRemovalReturn {
  return {
    isModelReady: sharedIsModelReady,
    modelLoadProgress: sharedModelLoadProgress,
    isProcessing: sharedIsProcessing,
    currentStage: sharedCurrentStage,
    init,
    removeBackground,
  };
}

/**
 * 初始化：下载并加载模型到内存（singleton，并发调用会合并为一次）
 */
async function init(): Promise<void> {
  // 已加载则直接返回
  if (sharedSession.value) {
    sharedIsModelReady.value = true;
    return;
  }
  // 正在加载中：复用同一个 promise，避免并发重复加载
  if (initPromise) return initPromise;
  initPromise = (async () => {
    sharedCurrentStage.value = 'loading-model';
    sharedModelLoadProgress.value = 0;

    // 检查缓存中是否已有模型
    const cached = await hasModel(RMBG_MODEL.id, RMBG_MODEL.version);
    let buffer: ArrayBuffer | undefined;

    if (cached) {
      buffer = await getModel(RMBG_MODEL.id, RMBG_MODEL.version);
      sharedModelLoadProgress.value = 1;
    } else {
      // 未缓存，下载并写入缓存
      buffer = await fetchAndCacheModel(
        RMBG_MODEL.id,
        RMBG_MODEL.version,
        RMBG_MODEL.url,
        (loaded, total) => {
          if (total > 0) {
            sharedModelLoadProgress.value = Math.min(1, loaded / total);
          } else {
            // total 未知时，用已下载量粗略估计
            sharedModelLoadProgress.value = Math.min(0.99, loaded / (loaded + 1));
          }
        },
      );
    }

    if (!buffer) {
      throw new Error('模型加载失败：无法获取模型数据');
    }

    // 创建推理 session
    sharedSession.value = await ort.InferenceSession.create(buffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    sharedModelLoadProgress.value = 1;
    sharedIsModelReady.value = true;
    sharedCurrentStage.value = '';
  })();
  try {
    await initPromise;
  } finally {
    // 加载完成（成功或失败）后清空 promise，允许失败后重试
    initPromise = null;
  }
}

/**
 * 抠图：输入 ImageData，返回带 alpha 的 ImageData
 * @param imageData 输入图像数据
 * @param options 抠图选项
 */
async function removeBackground(
  imageData: ImageData,
  options?: RemoveBgOptions,
): Promise<ImageData> {
  if (!sharedIsModelReady.value || !sharedSession.value) {
    throw new Error('模型未加载，请先调用 init()');
  }

  const threshold = options?.threshold ?? 128;
  const feather = options?.feather ?? true;
  // RMBG-1.4 模型要求固定 1024×1024 正方形输入，maxProcessSize 即模型输入边长
  const maxProcessSize = options?.maxProcessSize ?? 1024;
  // 软 alpha 模式默认开启：保留 mask 连续值，避免硬二值化导致的大面积残留
  const softAlpha = options?.softAlpha ?? true;
  const forceRemoveColor = options?.forceRemoveColor;

  sharedIsProcessing.value = true;

  try {
    const originalW = imageData.width;
    const originalH = imageData.height;

    // ---------- a. 预处理 ----------
    sharedCurrentStage.value = 'preprocessing';

    // 始终 resize 到 maxProcessSize × maxProcessSize（拉伸，不保持宽高比）
    // RMBG-1.4 的输入维度固定为 [1, 3, 1024, 1024]，传入其他尺寸会报
    // "Got invalid dimensions for input" 错误
    const processW = maxProcessSize;
    const processH = maxProcessSize;
    const inputImageData = resizeImageData(imageData, processW, processH);

    // 转 Float32Array，归一化到 [0,1]，CHW 排列（channel-first）
    const pixelCount = processW * processH;
    const chwData = new Float32Array(pixelCount * 3);
    const srcData = inputImageData.data;
    for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
      chwData[p] = srcData[i] / 255;                      // R 通道
      chwData[pixelCount + p] = srcData[i + 1] / 255;     // G 通道
      chwData[pixelCount * 2 + p] = srcData[i + 2] / 255; // B 通道
    }

    // ---------- b. 推理 ----------
    sharedCurrentStage.value = 'inference';

    const inputName = sharedSession.value.inputNames[0];
    const tensor = new ort.Tensor('float32', chwData, [1, 3, processH, processW]);
    const results = await sharedSession.value.run({ [inputName]: tensor });

    // ---------- c. 后处理 ----------
    sharedCurrentStage.value = 'postprocessing';

    const outputName = sharedSession.value.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data as Float32Array;

    // 找到 mask 的最小/最大值用于归一化
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < outputData.length; i++) {
      const v = outputData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;

    // 归一化到 [0, 255]
    const mask = new Uint8ClampedArray(outputData.length);
    for (let i = 0; i < outputData.length; i++) {
      mask[i] = ((outputData[i] - min) / range) * 255;
    }

    // 边缘羽化：3x3 box blur
    let blurredMask = mask;
    if (feather) {
      blurredMask = boxBlur3x3(mask, processW, processH);
    }

    // 生成 alpha mask
    // - 软 alpha 模式：保留 mask 连续值（threshold 以下截断为 0），边缘自然过渡
    // - 硬二值化模式：mask < threshold → 0，否则 255（旧逻辑，边缘生硬）
    const alphaMask = new Uint8ClampedArray(blurredMask.length);
    for (let i = 0; i < blurredMask.length; i++) {
      const v = blurredMask[i];
      if (softAlpha) {
        // threshold 作为下限截断，避免完全的背景被保留为半透明
        // 上限 255 保留，中间值线性映射，让边缘软过渡
        alphaMask[i] = v < threshold ? 0 : v;
      } else {
        alphaMask[i] = v < threshold ? 0 : 255;
      }
    }

    // 色度键兜底：强制移除指定颜色（如白色背景）
    // 对 RMBG 抠不干净的纯色背景特别有效
    if (forceRemoveColor) {
      const { r: fr, g: fg, b: fb, tolerance } = forceRemoveColor;
      const tolSq = tolerance * tolerance;
      const src = inputImageData.data;
      for (let p = 0; p < alphaMask.length; p++) {
        const i = p * 4;
        const dr = src[i] - fr;
        const dg = src[i + 1] - fg;
        const db = src[i + 2] - fb;
        // RGB 欧氏距离平方 ≤ tolerance² → 强制透明
        if (dr * dr + dg * dg + db * db <= tolSq) {
          alphaMask[p] = 0;
        }
      }
    }

    // ---------- d. 还原尺寸 ----------
    let finalAlphaMask = alphaMask;
    if (processW !== originalW || processH !== originalH) {
      // 将 mask 转为 RGBA ImageData 以便用 canvas 双线性插值上采
      const smallMaskImage = new ImageData(processW, processH);
      for (let i = 0, p = 0; i < smallMaskImage.data.length; i += 4, p++) {
        smallMaskImage.data[i] = alphaMask[p];
        smallMaskImage.data[i + 1] = alphaMask[p];
        smallMaskImage.data[i + 2] = alphaMask[p];
        smallMaskImage.data[i + 3] = 255;
      }
      const fullMaskImage = resizeImageData(smallMaskImage, originalW, originalH);
      finalAlphaMask = new Uint8ClampedArray(originalW * originalH);
      for (let i = 0, p = 0; i < fullMaskImage.data.length; i += 4, p++) {
        finalAlphaMask[p] = fullMaskImage.data[i];
      }
    }

    // ---------- e. 合成：保留原 RGB，应用新 alpha ----------
    sharedCurrentStage.value = 'done';
    return applyAlphaToImageData(imageData, finalAlphaMask);
  } finally {
    sharedIsProcessing.value = false;
  }
}
