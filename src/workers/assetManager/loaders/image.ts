import { AssetType } from '@arkntools/unity-js';
import type { Material, Sprite, Texture2D } from '@arkntools/unity-js';
import { imageConverterPool } from '@/workers/utils/imageConverterPool';
import { flipVerticalRgba, getSupportedFormats, isFormatSupported } from '@/utils/textureEncoder';
import { blobCache } from '../utils/cache';
import type { CacheKey } from '../utils/cache';
import { AssetLoader, PreviewType } from './default';
import type { AssetExportItem, LoaderOptions, PreviewDetail } from './default';
import {
  WHOLE_ATLAS_PAYLOAD,
  type PreviewFrameAnimationDetail,
} from '@/types/preview';
import type { FrameTileOffset } from '@/types/preview';
import { buildFrameGroups, parseCompositePayload, stripFrameSuffix, type CompositePayload } from '@/utils/frameAnim';

export class ImageLoader extends AssetLoader<Texture2D | Sprite | Material> {
  constructor(object: Texture2D | Sprite | Material, options?: LoaderOptions) {
    super(object, options);
  }

  override canExport(): boolean {
    return true;
  }

  async export(): Promise<AssetExportItem[] | null> {
    const blob = await this.getImageForExport();
    if (!blob) return null;

    return [
      {
        name: `${this.objNameForFile}.png`,
        blob,
      },
    ];
  }

  /** 与当前资产同 bundle 的全部 Sprite（帧动画分组候选） */
  private get siblingSprites(): Sprite[] {
    const objs = this.options?.objects ?? [];
    return objs.filter((o): o is Sprite => o.type === AssetType.Sprite);
  }

  /** 当前资产引用的图集 Texture2D pathId（Texture2D=自身；Sprite=其 texture 引用） */
  private resolveTexturePathId(): bigint | null {
    if (this.object.type === AssetType.Texture2D) return this.object.pathId;
    if (this.object.type === AssetType.Sprite) {
      const tex = this.object.spriteRenderData?.texture;
      return tex && !tex.isNull ? tex.pathId : null;
    }
    return null;
  }

  /** 与当前资产同图集（同 texture）的 Sprite 集合 */
  private atlasSprites(): Sprite[] {
    const texPathId = this.resolveTexturePathId();
    if (texPathId === null) return [];
    return this.siblingSprites.filter(s => s.spriteRenderData?.texture?.pathId === texPathId);
  }

  /** 解析同图集 Sprite 帧号并分组（仅保留 >=2 帧的动画组；无动画组返回 null） */
  private buildAnimDetail(): PreviewFrameAnimationDetail | null {
    const siblings = this.atlasSprites();
    if (!siblings.length) return null;

    const playable = buildFrameGroups(
      siblings.map(s => ({
        pathId: s.pathId,
        name: s.name,
        rect: { x: s.rect.x, y: s.rect.y, w: s.rect.w, h: s.rect.h },
        pivot: s.pivot,
      })),
    );
    if (!playable.length) return null;

    const isSprite = this.object.type === AssetType.Sprite;
    const ownGroup = isSprite
      ? playable.find(g => g.name === stripFrameSuffix(this.object.name))
      : undefined;
    const tex = isSprite
      ? this.object.spriteRenderData?.texture?.object
      : (this.object as Texture2D);

    return {
      type: PreviewType.FrameAnimation,
      atlasName: tex?.name ?? this.object.name,
      atlasWidth: tex?.width,
      atlasHeight: tex?.height,
      groups: playable,
      defaultGroup: ownGroup?.name ?? playable[0]!.name,
      textureFormat: tex?.textureFormat,
      width: tex?.width,
      height: tex?.height,
      canEdit: tex ? isFormatSupported(tex.textureFormat) : undefined,
      supportedFormats: tex ? getSupportedFormats() : undefined,
    };
  }

  override getPreviewDetail(): PreviewDetail {
    // 图集/切片构成可播放动画组 → 帧动画预览（含单帧图集视图）
    const anim = this.buildAnimDetail();
    if (anim) return anim;

    if (this.object.type === AssetType.Texture2D) {
      const tex = this.object as any;
      return {
        type: PreviewType.Image,
        textureFormat: tex.textureFormat,
        width: tex.width,
        height: tex.height,
        canEdit: isFormatSupported(tex.textureFormat),
        supportedFormats: getSupportedFormats(),
      };
    }
    if (this.object.type === AssetType.Sprite) {
      return {
        type: PreviewType.Image,
        canEdit: true,
      };
    }
    return { type: PreviewType.Image };
  }

  /**
   * 预览数据：
   * - payload = WHOLE_ATLAS_PAYLOAD → 整张图集
   * - payload = Sprite pathId 字符串 → 该帧切片图（单分块帧）
   * - payload = 复合帧字符串（COMPOSITE_PREFIX 开头）→ 多分块按 pivot 对齐合成整帧
   * - 无 payload：Texture2D 返回整图；Sprite 返回自身切片
   */
  override async getPreviewData(payload?: any): Promise<string | undefined> {
    const key = String(payload ?? '');
    const composite = parseCompositePayload(key);
    if (composite) {
      return this.getCompositePreview(composite);
    }
    if (key === WHOLE_ATLAS_PAYLOAD) {
      return this.getAtlasPreview();
    }
    if (key) {
      const sprite = this.siblingSprites.find(s => String(s.pathId) === key);
      if (sprite) return this.getSpriteFramePreview(sprite);
    }
    if (this.object.type === AssetType.Sprite) {
      return this.getSpriteFramePreview(this.object as Sprite);
    }
    return this.getAtlasPreview();
  }

  /**
   * 复合帧渲染：同一帧号的全部分块按 pivot 对齐，从解码后的图集上裁剪并
   * 粘贴到合成画布（y-down 纹理坐标系内布局），最后整体垂直翻转与其它预览一致。
   */
  private async getCompositePreview(c: CompositePayload): Promise<string | undefined> {
    const tex = this.textureObject;
    if (!tex) return;
    const cacheKey: CacheKey = {
      pathId: tex.pathId,
      subKey: `comp:${c.w}x${c.h}:${c.tiles.map(t => `${t.key}@${t.px},${t.py},${t.w},${t.h}`).join('|')}`,
    };
    const cached = blobCache.get(cacheKey);
    if (cached) return cached.url;

    const w = Math.max(1, Math.round(c.w));
    const h = Math.max(1, Math.round(c.h));
    // 病态布局兜底（pivot 极端偏移时限制内存/耗时）
    if (w > 8192 || h > 8192) return;

    const jimp = (tex as any).getImageJimpRaw() as any;
    const W = jimp?.bitmap?.width as number | undefined;
    const H = jimp?.bitmap?.height as number | undefined;
    if (!W || !H) return;
    const src = new Uint8Array(jimp.bitmap.data.buffer, jimp.bitmap.data.byteOffset, jimp.bitmap.data.byteLength);

    const canvas = new Uint8Array(w * h * 4);
    const spriteByKey = new Map(this.siblingSprites.map(s => [String(s.pathId), s]));
    for (const t of c.tiles) {
      const sprite = spriteByKey.get(t.key);
      if (!sprite) continue;
      const rx = Math.round(sprite.rect.x);
      const ry = Math.round(sprite.rect.y);
      const rw = Math.min(Math.round(sprite.rect.w), W - rx);
      const rh = Math.min(Math.round(sprite.rect.h), H - ry);
      if (rw <= 0 || rh <= 0 || rx < 0 || ry < 0) continue;
      const dx = Math.round(t.px);
      const dy = Math.round(t.py);
      for (let y = 0; y < rh; y++) {
        const cy = dy + y;
        if (cy < 0 || cy >= h) continue;
        const srcStart = (ry + y) * W + rx;
        const dstStart = cy * w + dx;
        for (let x = 0; x < rw; x++) {
          const si = (srcStart + x) * 4;
          const di = (dstStart + x) * 4;
          canvas[di] = src[si];
          canvas[di + 1] = src[si + 1];
          canvas[di + 2] = src[si + 2];
          canvas[di + 3] = src[si + 3];
        }
      }
    }

    const flipped = flipVerticalRgba(canvas as Uint8Array<ArrayBuffer>, w, h);
    const bitmap = { data: flipped.buffer as ArrayBuffer, width: w, height: h };
    const data = await imageConverterPool.addTask(bitmap);
    if (!data) return;

    const blob = new Blob([data], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    blobCache.set(cacheKey, { url, blob });
    return url;
  }

  private async getImage(): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const tex = this.textureObject;
    if (!tex) return;
    const bitmap = await tex.getImageBitmap();
    if (!bitmap) return;

    return await imageConverterPool.addTask(bitmap);
  }

  /** 解析到的图集 Texture2D（Texture2D=自身；Sprite=其 texture 引用；Material 无） */
  private get textureObject(): Texture2D | null {
    if (this.object.type === AssetType.Texture2D) return this.object as Texture2D;
    if (this.object.type === AssetType.Sprite) {
      return this.object.spriteRenderData?.texture?.object ?? null;
    }
    return null;
  }

  private async getAtlasPreview(): Promise<string | undefined> {
    const tex = this.textureObject;
    if (!tex) return;
    const key: CacheKey = { pathId: tex.pathId, subKey: 'atlas' };
    const item = blobCache.get(key);
    if (item) return item.url;

    const data = await this.getImage();
    if (!data) return;

    const blob = new Blob([data], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    blobCache.set(key, { url, blob });

    return url;
  }

  /** 单个 Sprite 切片帧的预览图（按 pathId 缓存） */
  private async getSpriteFramePreview(sprite: Sprite): Promise<string | undefined> {
    const key: CacheKey = { pathId: sprite.pathId };
    const item = blobCache.get(key);
    if (item) return item.url;

    const bitmap = await sprite.getImageBitmap();
    if (!bitmap) return;

    const data = await imageConverterPool.addTask(bitmap);
    if (!data) return;

    const blob = new Blob([data], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    blobCache.set(key, { url, blob });

    return url;
  }

  private async getImageForExport(): Promise<Blob | undefined> {
    const key: CacheKey = { pathId: this.object.pathId };
    const item = blobCache.get(key);
    if (item) return item.blob;

    const bitmap = await this.object.getImageBitmap();
    if (!bitmap) return;

    const data = await imageConverterPool.addTask(bitmap);
    if (data) return new Blob([data], { type: 'image/png' });
  }
}