import * as ort from 'onnxruntime-web';
import { ref, shallowRef, type Ref } from 'vue';
import {
  hasModel,
  getModel,
  setModel,
} from '@/utils/onnxModelCache';

/**
 * Removebg 1.5 Fast 模型（InSPyReNet, ONNX 格式）
 *
 * 模型来源：https://r.removebg.one/models/removebg-1.5/fast/inspyrenet-fast.onnx
 * 部署方式（二选一）：
 *   1. 脚本下载：node scripts/download-removebg-1.5-fast.cjs
 *   2. 在线下载：首次使用时自动从 r.removebg.one 下载（CORS 允许），缓存在 IndexedDB
 * 输入：384x384, RGB, [0,1] 归一化, CHW 排列
 * 输出：salience map [0,1]，单通道
 */

const FAST_MODEL_LOCAL_URL = '/models/removebg-1.5/fast/inspyrenet-fast.onnx';
const FAST_MODEL_REMOTE_URL = 'https://r.removebg.one/models/removebg-1.5/fast/inspyrenet-fast.onnx';
const FAST_MODEL_ID = 'removebg-1.5-fast';
const FAST_MODEL_VERSION = 1;
const FAST_INPUT_SIZE = 384;
// 模型文件约 386MB，最小有效大小设为 300MB 以过滤不完整下载
const FAST_MODEL_MIN_SIZE = 300 * 1024 * 1024;

export interface FastRemoveBgOptions {
  threshold?: number;
  feather?: boolean;
  softAlpha?: boolean;
}

export interface UseFastBgRemovalReturn {
  isModelReady: Ref<boolean>;
  modelLoadProgress: Ref<number>;
  isProcessing: Ref<boolean>;
  currentStage: Ref<string>;
  init: () => Promise<void>;
  removeBackground: (imageData: ImageData, options?: FastRemoveBgOptions) => Promise<ImageData>;
}

// 共享状态
const sharedSession = shallowRef<ort.InferenceSession | null>(null);
const sharedIsModelReady = ref(false);
const sharedModelLoadProgress = ref(0);
const sharedIsProcessing = ref(false);
const sharedCurrentStage = ref('');
let initPromise: Promise<void> | null = null;

function resizeImageData(src: ImageData, targetW: number, targetH: number): ImageData {
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

function boxBlur3x3(mask: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
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
 * 流式下载模型文件，显示实时进度
 */
async function downloadWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  let received = 0;
  const chunks: Uint8Array[] = [];

  if (reader && contentLength > 0) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, contentLength);
    }
  } else {
    const buf = await response.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    onProgress(buf.byteLength, buf.byteLength);
  }

  // 合并 chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const buffer = new ArrayBuffer(totalLength);
  const view = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

/**
 * 验证 buffer 是否为有效的 ONNX 模型
 * ONNX 文件以 protobuf 格式存储，魔数特征：
 * - 前几字节包含模型架构名（如 "pytorch"）
 * - 文件大小应 > 300MB（此模型约 386MB）
 */
function isValidOnnxModel(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < FAST_MODEL_MIN_SIZE) {
    console.warn(`[Fast Removebg] 文件大小 ${buffer.byteLength} 不达标（需 > ${FAST_MODEL_MIN_SIZE}）`);
    return false;
  }
  // 检查 ONNX protobuf 头部特征
  const header = new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength));
  const headerStr = new TextDecoder().decode(header);
  if (!headerStr.includes('pytorch') && !headerStr.includes('onnx')) {
    console.warn('[Fast Removebg] 文件头部无 ONNX/protobuf 特征');
    return false;
  }
  return true;
}

async function init(): Promise<void> {
  if (sharedSession.value) {
    sharedIsModelReady.value = true;
    return;
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    sharedCurrentStage.value = 'loading-model';
    sharedModelLoadProgress.value = 0;

    let buffer: ArrayBuffer | undefined;

    // 1. 检查 IndexedDB 缓存
    if (!buffer) {
      const cached = await hasModel(FAST_MODEL_ID, FAST_MODEL_VERSION);
      if (cached) {
        console.log('[Fast Removebg] 从 IndexedDB 缓存加载');
        const cachedBuf = await getModel(FAST_MODEL_ID, FAST_MODEL_VERSION);
        if (cachedBuf && isValidOnnxModel(cachedBuf)) {
          buffer = cachedBuf;
          sharedModelLoadProgress.value = 0.5;
        } else {
          console.warn('[Fast Removebg] IndexedDB 缓存无效，清除并重新下载');
        }
      }
    }

    // 2. 尝试从本地 public 目录加载（验证文件大小）
    if (!buffer) {
      try {
        const localResp = await fetch(FAST_MODEL_LOCAL_URL, { method: 'HEAD' });
        if (localResp.ok) {
          const localSize = parseInt(localResp.headers.get('content-length') || '0', 10);
          if (localSize >= FAST_MODEL_MIN_SIZE) {
            console.log('[Fast Removebg] 从本地文件加载');
            const localBuf = await downloadWithProgress(FAST_MODEL_LOCAL_URL, (received, total) => {
              sharedModelLoadProgress.value = Math.min(0.99, received / total);
            });
            if (isValidOnnxModel(localBuf)) {
              buffer = localBuf;
            }
          } else {
            console.warn(`[Fast Removebg] 本地文件不完整 (${localSize} bytes)，跳过`);
          }
        }
      } catch {
        // 本地文件不存在
      }
    }

    // 3. 从 r.removebg.one 在线下载（CORS: * 允许跨域）
    if (!buffer) {
      console.log('[Fast Removebg] 从 r.removebg.one 在线下载（约 386MB）...');
      try {
        const remoteBuf = await downloadWithProgress(FAST_MODEL_REMOTE_URL, (received, total) => {
          sharedModelLoadProgress.value = Math.min(0.99, received / total);
        });
        if (!isValidOnnxModel(remoteBuf)) {
          throw new Error('下载的模型文件无效或不完整');
        }
        buffer = remoteBuf;
        // 缓存到 IndexedDB
        await setModel(FAST_MODEL_ID, FAST_MODEL_VERSION, buffer);
        console.log('[Fast Removebg] 已缓存到 IndexedDB');
      } catch (e) {
        throw new Error(
          `在线下载失败: ${e instanceof Error ? e.message : e}。\n` +
          '也可手动运行: node scripts/download-removebg-1.5-fast.cjs',
        );
      }
    }

    if (!buffer) {
      throw new Error('模型加载失败：无法获取有效的模型数据');
    }

    sharedModelLoadProgress.value = 0.99;

    ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
    ort.env.wasm.numThreads = 1;

    try {
      sharedSession.value = await ort.InferenceSession.create(buffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      // protobuf 解析失败 → 缓存可能损坏，清除后提示重新下载
      console.error('[Fast Removebg] ONNX 会话创建失败:', e);
      throw new Error(
        `模型解析失败（protobuf parsing failed）。\n` +
        '可能原因：下载不完整或缓存损坏。\n' +
        '请清除浏览器 IndexedDB 后重试，或运行 node scripts/download-removebg-1.5-fast.cjs 手动下载。',
      );
    }

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

async function removeBackground(
  imageData: ImageData,
  options?: FastRemoveBgOptions,
): Promise<ImageData> {
  if (!sharedIsModelReady.value || !sharedSession.value) {
    throw new Error('模型未加载，请先调用 init()');
  }

  const threshold = options?.threshold ?? 128;
  const feather = options?.feather ?? true;
  const softAlpha = options?.softAlpha ?? true;

  sharedIsProcessing.value = true;

  try {
    const originalW = imageData.width;
    const originalH = imageData.height;

    // ---------- a. 预处理 ----------
    sharedCurrentStage.value = 'preprocessing';

    // 缩放到 384x384（拉伸，不保持宽高比）
    const processW = FAST_INPUT_SIZE;
    const processH = FAST_INPUT_SIZE;
    const inputImageData = resizeImageData(imageData, processW, processH);

    // 归一化到 [0,1]，CHW 排列
    const pixelCount = processW * processH;
    const chwData = new Float32Array(pixelCount * 3);
    const srcData = inputImageData.data;
    for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
      chwData[p] = srcData[i] / 255;
      chwData[pixelCount + p] = srcData[i + 1] / 255;
      chwData[pixelCount * 2 + p] = srcData[i + 2] / 255;
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

    // 找 min/max 归一化到 [0, 255]
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < outputData.length; i++) {
      const v = outputData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;

    const mask = new Uint8ClampedArray(outputData.length);
    for (let i = 0; i < outputData.length; i++) {
      mask[i] = ((outputData[i] - min) / range) * 255;
    }

    // 边缘羽化
    let blurredMask: Uint8ClampedArray = mask;
    if (feather) {
      blurredMask = boxBlur3x3(mask, processW, processH);
    }

    // 生成 alpha mask
    const alphaMask = new Uint8ClampedArray(blurredMask.length);
    for (let i = 0; i < blurredMask.length; i++) {
      const v = blurredMask[i];
      if (softAlpha) {
        alphaMask[i] = v < threshold ? 0 : v;
      } else {
        alphaMask[i] = v < threshold ? 0 : 255;
      }
    }

    // ---------- d. 还原尺寸 ----------
    // 创建带 alpha 的 ImageData
    const resultImageData = new ImageData(processW, processH);
    const dst = resultImageData.data;
    for (let p = 0, i = 0; p < alphaMask.length; p++, i += 4) {
      dst[i] = inputImageData.data[i];
      dst[i + 1] = inputImageData.data[i + 1];
      dst[i + 2] = inputImageData.data[i + 2];
      dst[i + 3] = alphaMask[p];
    }

    // 还原到原始尺寸
    if (processW !== originalW || processH !== originalH) {
      return resizeImageData(resultImageData, originalW, originalH);
    }
    return resultImageData;
  } finally {
    sharedIsProcessing.value = false;
    sharedCurrentStage.value = '';
  }
}

export function useFastBgRemoval(): UseFastBgRemovalReturn {
  return {
    isModelReady: sharedIsModelReady,
    modelLoadProgress: sharedModelLoadProgress,
    isProcessing: sharedIsProcessing,
    currentStage: sharedCurrentStage,
    init,
    removeBackground,
  };
}
