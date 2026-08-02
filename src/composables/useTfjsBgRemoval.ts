import * as tf from '@tensorflow/tfjs';
import { ref, shallowRef, type Ref } from 'vue';

/**
 * Removebg 1.6 通用模型信息
 * TF.js graph-model 格式
 *
 * 加载策略（自动选择）：
 *   1. 优先从本地 public/models/removebg-1.6/universal/ 加载
 *   2. 本地不存在时，从 r.removebg.one 在线加载（CORS: * 允许跨域）
 *   3. 首次加载后浏览器 HTTP 缓存会加速后续启动
 *
 * 手动部署（可选，避免每次清缓存后重新在线加载）：
 *   运行 node scripts/download-removebg-model.cjs 下载到 public 目录
 */
const TFJS_MODEL_LOCAL_URL = '/models/removebg-1.6/universal/model.json';
const TFJS_MODEL_REMOTE_URL = 'https://r.removebg.one/models/removebg-1.6/universal/model.json';

/**
 * 抠图选项（与 useBackgroundRemoval 保持一致接口）
 */
export interface TfjsRemoveBgOptions {
  /** 二值化阈值，mask < threshold → alpha=0，默认 128 */
  threshold?: number;
  /** 是否启用边缘羽化（3x3 高斯模糊），默认 true */
  feather?: boolean;
  /** 软 alpha 模式：保留 mask 连续值作为 alpha，默认 true */
  softAlpha?: boolean;
}

/**
 * useTfjsBgRemoval 返回值
 */
export interface UseTfjsBgRemovalReturn {
  isModelReady: Ref<boolean>;
  modelLoadProgress: Ref<number>;
  isProcessing: Ref<boolean>;
  currentStage: Ref<string>;
  init: () => Promise<void>;
  removeBackground: (imageData: ImageData, options?: TfjsRemoveBgOptions) => Promise<ImageData>;
}

// ---------- 工具函数（与 useBackgroundRemoval 共用逻辑） ----------

function resizeImageData(src: ImageData, targetW: number, targetH: number): ImageData {
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

function applyAlphaToImageData(rgba: ImageData, mask: Uint8ClampedArray): ImageData {
  const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height);
  const data = out.data;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    data[i + 3] = mask[p];
  }
  return out;
}

function gaussianBlur5x5(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  // 5x5 Gaussian kernel (sigma ≈ 1.0), 边缘更平滑自然
  const kernel = [
    1,  4,  6,  4, 1,
    4, 16, 24, 16, 4,
    6, 24, 36, 24, 6,
    4, 16, 24, 16, 4,
    1,  4,  6,  4, 1,
  ];
  const kernelSum = 256;
  const out = new Uint8ClampedArray(mask.length);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          sum += mask[(y + dy) * width + (x + dx)] * kernel[(dy + 2) * 5 + (dx + 2)];
        }
      }
      out[y * width + x] = Math.round(sum / kernelSum);
    }
  }
  // 边缘像素保持原值（不模糊）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < 2 || x >= width - 2 || y < 2 || y >= height - 2) {
        out[y * width + x] = mask[y * width + x];
      }
    }
  }
  return out;
}

// ---------- 模块级共享状态（singleton） ----------

const sharedModel = shallowRef<tf.GraphModel | null>(null);
const sharedIsModelReady = ref<boolean>(false);
const sharedModelLoadProgress = ref<number>(0);
const sharedIsProcessing = ref<boolean>(false);
const sharedCurrentStage = ref<string>('');
let initPromise: Promise<void> | null = null;

/**
 * TF.js 背景移除 composable（Removebg 1.6 通用模型）
 */
export function useTfjsBgRemoval(): UseTfjsBgRemovalReturn {
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
 * 初始化：下载并加载 TF.js 模型
 */
async function init(): Promise<void> {
  if (sharedModel.value) {
    sharedIsModelReady.value = true;
    return;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    sharedCurrentStage.value = 'loading-model';
    sharedModelLoadProgress.value = 0;

    // 设置后端为 WebGL（GPU 加速），回退到 CPU
    try {
      await tf.setBackend('webgl');
    } catch {
      await tf.setBackend('cpu');
    }
    await tf.ready();

    // 加载 graph model
    // 优先本地 public 目录，不存在则从 r.removebg.one 在线加载（CORS: *）
    // TF.js loadGraphModel 会自动下载 model.json 引用的所有 .bin 权重分片
    let modelUrl = TFJS_MODEL_LOCAL_URL;
    try {
      const localCheck = await fetch(TFJS_MODEL_LOCAL_URL, { method: 'HEAD' });
      if (!localCheck.ok) throw new Error('本地 model.json 不存在');
      console.log('[TF.js Removebg] 从本地加载模型');
    } catch {
      console.log('[TF.js Removebg] 本地未找到，从 r.removebg.one 在线加载（约 196MB）...');
      modelUrl = TFJS_MODEL_REMOTE_URL;
    }

    const model = await tf.loadGraphModel(modelUrl, {
      onProgress: (fraction: number) => {
        sharedModelLoadProgress.value = Math.min(1, fraction);
      },
    });

    sharedModel.value = model;
    sharedModelLoadProgress.value = 1;
    sharedIsModelReady.value = true;
    sharedCurrentStage.value = '';
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * 抠图：输入 ImageData，返回带 alpha 的 ImageData
 */
/**
 * 照着 removebg.one 网站的 s() 函数：将图片画到白底 canvas 上再取 ImageData
 * 确保透明图片的透明区域变成白色，与模型训练时的输入一致
 *
 * 注意：putImageData 不会缩放图片，必须用 drawImage 才能正确缩放
 */
function compositeOnWhite(source: ImageData, targetW: number, targetH: number): ImageData {
  // 1. 先把原图放到临时 canvas（原始尺寸）
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = source.width;
  srcCanvas.height = source.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('无法创建 canvas 2d 上下文');
  srcCtx.putImageData(source, 0, 0);

  // 2. 目标 canvas：白底 + 缩放后的图片
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文');

  // 白底（removebg.one 的 s() 函数：o.fillStyle="#fff", o.fillRect(0,0,n,r)）
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, targetW, targetH);

  // 把原图缩放到目标尺寸贴上去（drawImage 会正确缩放，putImageData 不会！）
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);

  return ctx.getImageData(0, 0, targetW, targetH);
}

async function removeBackground(
  imageData: ImageData,
  options?: TfjsRemoveBgOptions,
): Promise<ImageData> {
  if (!sharedIsModelReady.value || !sharedModel.value) {
    throw new Error('模型未加载，请先调用 init()');
  }

  const threshold = options?.threshold ?? 128;
  const feather = options?.feather ?? true;
  const softAlpha = options?.softAlpha ?? true;

  sharedIsProcessing.value = true;

  try {
    const originalW = imageData.width;
    const originalH = imageData.height;

    // ---------- a. 预处理（照抄 removebg.one 的 s() 函数） ----------
    sharedCurrentStage.value = 'preprocessing';

    // 按长边缩放到 MAX_SIDE 以内，保持宽高比
    // manifest.json: local-v16-universal maxSide = 1200
    const MAX_SIDE = 1200;
    let processW = originalW;
    let processH = originalH;
    if (Math.max(originalW, originalH) > MAX_SIDE) {
      const scale = MAX_SIDE / Math.max(originalW, originalH);
      processW = Math.max(1, Math.round(originalW * scale));
      processH = Math.max(1, Math.round(originalH * scale));
    }

    // 照抄 removebg.one s()：先画白底，再贴原图 → 透明区域变白色
    // 避免透明 PNG 的透明像素（RGB=0,0,0）被模型误判为黑色背景
    const inputImageData = compositeOnWhite(imageData, processW, processH);

    // 关键：模型内置 ImageNet 归一化（model.json 含 Sub/Div/mean 节点）
    // 网站不做外部归一化，直接传 [0,255] float 像素值
    // 之前代码做了双重归一化，导致颜色失真和质量低下
    const pixelCount = processW * processH;
    const hwcData = new Float32Array(pixelCount * 3);
    const srcData = inputImageData.data;
    for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
      hwcData[p * 3] = srcData[i];           // R: 0-255
      hwcData[p * 3 + 1] = srcData[i + 1];   // G: 0-255
      hwcData[p * 3 + 2] = srcData[i + 2];   // B: 0-255
    }

    // ---------- b. 推理 ----------
    sharedCurrentStage.value = 'inference';

    const inputTensor = tf.tensor3d(hwcData, [processH, processW, 3]);
    let outputTensor: tf.Tensor;

    try {
      const results = await sharedModel.value.executeAsync(
        { input_image: inputTensor },
        'output_png',
      );
      if (Array.isArray(results)) {
        outputTensor = results[0];
      } else {
        outputTensor = results;
      }
    } finally {
      inputTensor.dispose();
    }

    // ---------- c. 后处理 ----------
    sharedCurrentStage.value = 'postprocessing';

    // output_png 节点定义是 Cast(DT_FLOAT→DT_UINT8)，但 TF.js 后端
    // 可能返回 uint8、int32 或 float32，需要运行时检测
    const rawData = await outputTensor.data();
    const actualDtype = outputTensor.dtype;
    outputTensor.dispose();

    console.log('[TF.js Removebg] 实际 dtype:', actualDtype, 'rawData.constructor:', rawData.constructor.name);

    // 统一将模型输出转为 [0,255] 范围的 RGBA uint8 数组
    const modelRgba = new Uint8ClampedArray(pixelCount * 4);
    if (rawData instanceof Uint8Array || rawData instanceof Int32Array) {
      // uint8 或 int32：值已在 [0,255] 范围
      const len = Math.min(rawData.length, modelRgba.length);
      for (let i = 0; i < len; i++) {
        modelRgba[i] = rawData[i];
      }
    } else {
      // float32：需要检测值范围并缩放
      const f32Data = rawData as Float32Array;
      let maxVal = 0;
      const sampleStep = Math.max(1, Math.floor(f32Data.length / 20000));
      for (let i = 0; i < f32Data.length; i += sampleStep) {
        const v = f32Data[i];
        if (v > maxVal) maxVal = v;
      }
      console.log('[TF.js Removebg] float32 采样最大值:', maxVal);
      const scale = maxVal <= 1.5 ? 255 : 1;
      const len = Math.min(f32Data.length, modelRgba.length);
      for (let i = 0; i < len; i++) {
        modelRgba[i] = Math.round(f32Data[i] * scale);
      }
    }

    // 提取模型的 alpha mask（第4通道）
    // 模型 RGB 前景可能是黑色/不准，但 alpha 通道（分割遮罩）是准确的
    const modelAlpha = new Uint8ClampedArray(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
      modelAlpha[p] = modelRgba[p * 4 + 3];
    }

    // 混合策略：用模型 alpha + 原始 RGB，边缘区域去白底
    // - 完全不透明 (alpha≈255)：直接用原始 RGB，颜色完美
    // - 完全透明 (alpha≈0)：alpha=0，RGB 不可见
    // - 半透明边缘 (0<alpha<255)：原始 RGB 被白色背景污染，需要反预乘去白底
    //   公式：foreground = (original/255 - (1 - alpha/255)) / (alpha/255)
    //   即从原始像素中移除白色背景的贡献，提取纯前景颜色
    const srcRgb = inputImageData.data;
    let resultImageData = new ImageData(processW, processH);
    const dst = resultImageData.data;

    for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
      const a = modelAlpha[p];
      if (a >= 250) {
        // 完全不透明：直接用原始 RGB，无背景污染
        dst[i] = srcRgb[i];
        dst[i + 1] = srcRgb[i + 1];
        dst[i + 2] = srcRgb[i + 2];
        dst[i + 3] = 255;
      } else if (a <= 5) {
        // 完全透明
        dst[i] = 0;
        dst[i + 1] = 0;
        dst[i + 2] = 0;
        dst[i + 3] = 0;
      } else {
        // 半透明边缘：反预乘去白底（假设白底背景）
        const alphaNorm = a / 255;
        const invAlpha = 1 - alphaNorm;
        for (let c = 0; c < 3; c++) {
          // 从原始像素中移除白色背景(255)的贡献
          const origNorm = srcRgb[i + c] / 255;
          const fg = (origNorm - invAlpha) / alphaNorm;
          dst[i + c] = Math.max(0, Math.min(255, Math.round(fg * 255)));
        }
        dst[i + 3] = a;
      }
    }

    // 还原到原始尺寸
    if (processW !== originalW || processH !== originalH) {
      resultImageData = resizeImageData(resultImageData, originalW, originalH);
    }

    // alpha 后处理：先羽化再阈值
    if (feather) {
      const alphaChannel = new Uint8ClampedArray(originalW * originalH);
      const data = resultImageData.data;
      for (let p = 0, i = 3; p < alphaChannel.length; p++, i += 4) {
        alphaChannel[p] = data[i];
      }
      const blurred = gaussianBlur5x5(alphaChannel, originalW, originalH);
      for (let p = 0, i = 3; p < blurred.length; p++, i += 4) {
        data[i] = blurred[p];
      }
    }

    if (threshold > 0) {
      const data = resultImageData.data;
      for (let i = 3; i < data.length; i += 4) {
        if (softAlpha) {
          if (data[i] < threshold) data[i] = 0;
        } else {
          data[i] = data[i] < threshold ? 0 : 255;
        }
      }
    }

    sharedCurrentStage.value = 'done';
    return resultImageData;
  } finally {
    sharedIsProcessing.value = false;
  }
}
