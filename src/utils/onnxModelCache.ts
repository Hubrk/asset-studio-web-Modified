import { createStore, get, set } from 'idb-keyval';

/**
 * ONNX 模型信息
 */
export type ModelInfo = {
  id: string;
  version: number;
  url: string;
  size: number;
};

/**
 * RMBG-1.4 模型信息（用于背景移除，size 未知故为 0）
 */
export const RMBG_MODEL: ModelInfo = {
  id: 'rmbg-1.4',
  version: 1,
  url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx',
  size: 0,
};

/**
 * 下载进度回调函数类型
 * @param loaded 已下载字节数
 * @param total 总字节数（未知时为 0）
 */
type ProgressCallback = (loaded: number, total: number) => void;

// 为 ONNX 模型缓存创建独立的 IndexedDB 存储实例，避免与其他数据混用
const onnxModelStore = createStore('onnx-model-cache-db', 'onnx-model-store');

/**
 * 构造模型缓存 key
 * @param modelId 模型 ID
 * @param version 模型版本
 * @returns 形如 `onnx-model:rmbg-1.4:1` 的缓存 key
 */
const buildKey = (modelId: string, version: number) => `onnx-model:${modelId}:${version}`;

/**
 * 从缓存中读取模型二进制数据
 * @param modelId 模型 ID
 * @param version 模型版本
 * @returns 模型二进制数据，未缓存时返回 undefined
 */
export const getModel = (modelId: string, version: number) =>
  get<ArrayBuffer>(buildKey(modelId, version), onnxModelStore);

/**
 * 将模型二进制数据写入缓存
 * @param modelId 模型 ID
 * @param version 模型版本
 * @param data 模型二进制数据
 */
export const setModel = (modelId: string, version: number, data: ArrayBuffer) =>
  set(buildKey(modelId, version), data, onnxModelStore);

/**
 * 检查缓存中是否存在指定模型
 * @param modelId 模型 ID
 * @param version 模型版本
 * @returns 是否已缓存
 */
export const hasModel = async (modelId: string, version: number) => {
  const data = await getModel(modelId, version);
  return !!data;
};

/**
 * 从 URL 下载模型并写入缓存，支持下载进度回调和自定义请求头
 * @param modelId 模型 ID
 * @param version 模型版本
 * @param url 模型下载地址
 * @param onProgress 可选的下载进度回调
 * @param headers 可选的自定义请求头（如 HuggingFace Authorization）
 * @returns 下载完成的模型二进制数据
 */
export const fetchAndCacheModel = async (
  modelId: string,
  version: number,
  url: string,
  onProgress?: ProgressCallback,
  headers?: Record<string, string>,
): Promise<ArrayBuffer> => {
  // 使用 XMLHttpRequest 替代 fetch，对大文件更可靠（避免 service worker 拦截和流式读取中断）
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    // 禁用缓存，确保 service worker 不会拦截
    xhr.setRequestHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }
    }

    xhr.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      } else if (event.loaded) {
        onProgress?.(event.loaded, 0);
      }
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = xhr.response as ArrayBuffer;
        try {
          await setModel(modelId, version, data);
          onProgress?.(data.byteLength, data.byteLength);
          resolve(data);
        } catch (e) {
          // 缓存写入失败仍返回数据，不阻塞加载
          console.warn('[onnxModelCache] 缓存写入失败，但仍返回数据:', e);
          resolve(data);
        }
      } else {
        reject(new Error(`下载模型失败: ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error(`网络错误：无法加载模型（可能是 service worker 拦截或文件不存在）`));
    xhr.ontimeout = () => reject(new Error('下载超时'));
    xhr.timeout = 600000; // 10 分钟超时，适配大文件慢速加载

    xhr.send();
  });
};
