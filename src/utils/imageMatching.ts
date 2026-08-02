/**
 * 纹理原名匹配模块
 *
 * 用于将外部图片文件按"原名"匹配回 bundle 内的 Texture2D 资源：
 * 1. extractTextureNameIndex：扫描所有 bundle 的 Texture2D 对象，按纹理名建索引
 * 2. matchImagesToTextures：用图片文件名去索引里查匹配，多个匹配全部返回交给 UI 选择
 * 3. extractLongestDigitId：从文件名提取最长连续数字串（复用已有逻辑）
 */
import { AssetType } from '@arkntools/unity-js';

/** 纹理索引条目：单个 Texture2D 的定位信息 */
export interface TextureEntry {
  bundleFileName: string;
  pathId: bigint;
  textureName: string;
  /** 纹理宽度（来自 preview，用于按尺寸匹配） */
  width?: number;
  /** 纹理高度（来自 preview，用于按尺寸匹配） */
  height?: number;
}

/** 图片匹配结果：图片名 + 对应纹理定位信息 */
export interface MatchResult {
  imageName: string;
  bundleFileName: string;
  pathId: bigint;
  textureName: string;
  /** 兜底匹配：图片尺寸与纹理不一致，需裁剪后缩放 */
  isFallback?: boolean;
}

/** Bundle 纹理列表（已过滤的 Texture2D 集合，可用于外部缓存/序列化） */
export interface BundleTextures {
  fileName: string;
  textures: Array<{ name: string; pathId: bigint }>;
}

/**
 * Bundle 资源列表：extractTextureNameIndex 的输入
 * assets 需至少包含 name、pathId、type 三个字段，便于内部按 Texture2D 类型过滤
 * 兼容 AssetObject（type: AssetType 数字枚举）与 worker 内 AssetInfo（type: 字符串名）两种来源
 */
export interface BundleAssetList {
  fileName: string;
  assets: Array<{
    name: string;
    pathId: bigint;
    type: AssetType | string;
    /** 纹理宽度（来自 preview，用于按尺寸匹配） */
    width?: number;
    /** 纹理高度（来自 preview，用于按尺寸匹配） */
    height?: number;
  }>;
}

/** 常见图片扩展名（不区分大小写），用于纹理名/图片名去扩展名 */
const IMAGE_EXTENSION_RE = /\.(?:png|jpg|jpeg|tga|bmp)$/i;

/** 去掉常见图片扩展名，返回纯净名 */
const stripImageExtension = (name: string): string => name.replace(IMAGE_EXTENSION_RE, '');

// ====== 匹配模式（增强图片匹配复制） ======

/** 匹配模式 */
export type MatchMode = 'exact' | 'contains' | 'regex';

/** 匹配选项 */
export interface MatchOptions {
  /** 匹配模式，默认 'exact' */
  mode: MatchMode;
  /** 是否忽略大小写，默认 false */
  caseInsensitive: boolean;
  /** 正则表达式模式（仅 mode='regex' 时有效） */
  regexPattern?: string;
}

/** 默认匹配选项：精确匹配，区分大小写 */
export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  mode: 'exact',
  caseInsensitive: false,
};

/**
 * 判断文件名是否匹配目标名
 *
 * @param fileName 文件名（含扩展名）
 * @param targetName 目标匹配名（已去扩展名）
 * @param options 匹配选项
 * @returns 是否匹配
 */
export const matchName = (fileName: string, targetName: string, options: MatchOptions = DEFAULT_MATCH_OPTIONS): boolean => {
  let name = stripImageExtension(fileName);
  let target = targetName;

  if (options.caseInsensitive) {
    name = name.toLowerCase();
    target = target.toLowerCase();
  }

  switch (options.mode) {
    case 'exact':
      return name === target;
    case 'contains':
      return name.includes(target);
    case 'regex':
      try {
        const re = new RegExp(options.regexPattern || '', options.caseInsensitive ? 'i' : '');
        return re.test(name);
      } catch {
        return false;
      }
    default:
      return name === target;
  }
};

/** 判断资源 type 是否为 Texture2D（同时兼容数字枚举值与字符串名） */
const isTexture2D = (type: AssetType | string): boolean =>
  type === AssetType.Texture2D || String(type) === AssetType[AssetType.Texture2D];

/**
 * 从文件名提取最长连续数字串
 *
 * 复用 assetManager 中 extractFileId 的核心逻辑：
 * 先去主扩展名，再 match /\d+/g，取最长的一段。
 *
 * 示例：
 *   '271284344_new.png' → '271284344'
 *   'avatar_123_4567.tga' → '4567'
 *   'no_id_here' → ''（无数字返回空串）
 *
 * @param fileName 文件名（可含扩展名）
 * @returns 最长连续数字串；若无数字则返回空串
 */
export function extractLongestDigitId(fileName: string): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const numbers = baseName.match(/\d+/g);
  if (numbers && numbers.length > 0) {
    return numbers.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), '');
  }
  return '';
}

/**
 * 遍历所有 bundle 的所有 Texture2D 类型对象，以纹理名（不含扩展名）为 key 建索引
 *
 * - 多个 bundle 内同名纹理会聚合到同一个 key 的数组下
 * - 同名 key 下的条目顺序遵循输入顺序（bundle 顺序 → bundle 内 assets 顺序）
 * - 纹理名取 obj.name，去掉常见扩展名（.png/.jpg/.jpeg/.tga/.bmp）
 * - 空名纹理（去扩展名后为空）会被跳过
 *
 * @param bundles bundle 文件列表，每个含 fileName 与 AssetInfo[]
 * @returns Map<纹理名, TextureEntry[]>
 */
export function extractTextureNameIndex(bundles: BundleAssetList[]): Map<string, TextureEntry[]> {
  const index = new Map<string, TextureEntry[]>();
  for (const bundle of bundles) {
    const { fileName: bundleFileName } = bundle;
    for (const asset of bundle.assets) {
      if (!isTexture2D(asset.type)) continue;
      const textureName = stripImageExtension(asset.name);
      if (!textureName) continue;
      const entry: TextureEntry = {
        bundleFileName,
        pathId: asset.pathId,
        textureName,
        width: asset.width,
        height: asset.height,
      };
      const list = index.get(textureName);
      if (list) {
        list.push(entry);
      } else {
        index.set(textureName, [entry]);
      }
    }
  }
  return index;
}

/**
 * 对每个图片文件名（去扩展名）在 textureIndex 中查找匹配
 *
 * - 多个匹配时全部返回，让 UI 让用户选
 * - 找不到匹配的图片会被静默跳过（不写入结果）
 * - 图片名顺序保留在结果中；同一图片多个匹配时按索引内顺序追加
 *
 * @param textureIndex 由 extractTextureNameIndex 构建的纹理索引
 * @param imageFileNames 待匹配的图片文件名列表
 * @returns 匹配结果数组
 */
export function matchImagesToTextures(
  textureIndex: Map<string, TextureEntry[]>,
  imageFileNames: string[],
  options?: MatchOptions,
): MatchResult[] {
  const results: MatchResult[] = [];
  const opts = options || DEFAULT_MATCH_OPTIONS;
  for (const imageName of imageFileNames) {
    const key = stripImageExtension(imageName);
    // 使用 matchName 增强匹配
    const matchedEntries: TextureEntry[] = [];
    for (const [idxKey, entries] of textureIndex) {
      if (matchName(imageName, idxKey, opts)) {
        for (const entry of entries) {
          matchedEntries.push(entry);
        }
      }
    }
    for (const entry of matchedEntries) {
      results.push({
        imageName,
        bundleFileName: entry.bundleFileName,
        pathId: entry.pathId,
        textureName: entry.textureName,
      });
    }
  }
  return results;
}

/**
 * 从图片文件名中提取尺寸信息，可选去除匹配后缀
 * 格式：{name}_{width}x{height}[suffix].{ext}
 * 如 "hero_1024x1024.png" → { baseName: "hero", width: 1024, height: 1024 }
 * 如 "hero_1024x1024_generated.png" + suffix="_generated" → { baseName: "hero", width: 1024, height: 1024 }
 * 如 "hero.png" → null（无尺寸信息）
 *
 * @param imageName 图片文件名
 * @param suffix 可选，要去除的文件名后缀（如 "_generated"），去除后再提取尺寸
 */
export function extractSizeFromImageName(imageName: string, suffix?: string): { baseName: string; width: number; height: number } | null {
  let nameNoExt = stripImageExtension(imageName);
  // 如果指定了后缀且文件名以该后缀结尾，先去除
  if (suffix && nameNoExt.endsWith(suffix)) {
    nameNoExt = nameNoExt.slice(0, -suffix.length);
  }
  const match = nameNoExt.match(/^(.+)_(\d+)x(\d+)$/i);
  if (!match) return null;
  const w = parseInt(match[2], 10);
  const h = parseInt(match[3], 10);
  if (w <= 0 || h <= 0) return null;
  return { baseName: match[1], width: w, height: h };
}

/**
 * 按纹理名+尺寸匹配图片（比纯名称匹配更精确，避免同名不同尺寸纹理冲突）
 *
 * 流程：
 * 1. 从图片文件名提取尺寸（如 "hero_1024x1024.png" → baseName="hero", w=1024, h=1024）
 * 2. 在 textureIndex 中查找 baseName 匹配的条目
 * 3. 过滤：纹理的 width/height 与图片尺寸一致（容差为 0，精确匹配）
 * 4. 如果图片没有尺寸信息，回退到纯名称匹配
 *
 * @param textureIndex 由 extractTextureNameIndex 构建的纹理索引
 * @param imageFileNames 待匹配的图片文件名列表
 * @param suffix 可选，匹配时去除的文件名后缀（如 "_generated"）
 * @returns 匹配结果数组
 */
export function matchImagesToTexturesBySize(
  textureIndex: Map<string, TextureEntry[]>,
  imageFileNames: string[],
  suffix?: string,
): MatchResult[] {
  const results: MatchResult[] = [];
  for (const imageName of imageFileNames) {
    const sizeInfo = extractSizeFromImageName(imageName, suffix);

    if (sizeInfo) {
      // 按尺寸匹配：先查名称，再过滤尺寸
      const entries = textureIndex.get(sizeInfo.baseName);
      if (!entries) continue;
      for (const entry of entries) {
        // 精确匹配尺寸（允许纹理没有尺寸信息时宽容匹配）
        if (entry.width === sizeInfo.width && entry.height === sizeInfo.height) {
          results.push({
            imageName,
            bundleFileName: entry.bundleFileName,
            pathId: entry.pathId,
            textureName: entry.textureName,
          });
        }
      }
    } else {
      // 无尺寸信息，回退到纯名称匹配
      const key = stripImageExtension(imageName);
      const entries = textureIndex.get(key);
      if (!entries || entries.length === 0) continue;
      for (const entry of entries) {
        results.push({
          imageName,
          bundleFileName: entry.bundleFileName,
          pathId: entry.pathId,
          textureName: entry.textureName,
        });
      }
    }
  }
  return results;
}
