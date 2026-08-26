import { AssetType } from '@arkntools/unity-js';
import type { AssetObject } from '@arkntools/unity-js';
import { blobCache, spineCache } from '../utils/cache';
import { AudioClipLoader } from './audioClip';
import { AssetLoader } from './default';
import type { LoaderOptions } from './default';
import { ImageLoader } from './image';
import { MonoBehaviourLoader } from './monoBehaviour';
import { TextAssetLoader } from './textAsset';

export * from './default';

const loaderMap = {
  [AssetType.TextAsset]: TextAssetLoader,
  [AssetType.Texture2D]: ImageLoader,
  [AssetType.Sprite]: ImageLoader,
  [AssetType.AudioClip]: AudioClipLoader,
  [AssetType.Material]: ImageLoader,
  [AssetType.MonoBehaviour]: MonoBehaviourLoader,
} as any as Record<AssetType, typeof AssetLoader | undefined>;

export const createLoader = (object: AssetObject, options?: LoaderOptions) => {
  const Loader = loaderMap[object.type];
  if (!Loader) return new AssetLoader(object, options);
  return new Loader(object, options);
};

/** 清除预览缓存；fileId 参数为兼容旧调用保留（当前缓存未按文件分桶，全量清除） */
export const clearCache = (_fileId?: string) => {
  blobCache.clear();
  spineCache.clear();
};
