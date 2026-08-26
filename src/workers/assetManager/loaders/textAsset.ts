import type { TextAsset } from '@arkntools/unity-js';
import { isJSON, isString } from 'es-toolkit';
import type { RepoDataHandler } from '@/types/repository';
import { getKfbKeys, isKfbContainer, kfbContainerToXml } from '@/utils/kfb';
import { isData } from '../utils/is';
import { AssetLoader, PreviewType } from './default';
import type { AssetExportItem, PreviewDetail } from './default';

export class TextAssetLoader extends AssetLoader<TextAsset> {
  protected static readonly textDecoder = new TextDecoder('utf-8');

  /** 是否为 KFB 战斗逻辑容器（数据首两字节 00 0E/00 0F） */
  isKfb(): boolean {
    return isKfbContainer(this.object.data);
  }

  /** 尝试解密 + 解码为可读 XML；失败（如无密钥）返回 null */
  async tryKfbXml(): Promise<string | null> {
    try {
      const container = this.object.data instanceof Uint8Array
        ? this.object.data
        : new Uint8Array(this.object.data as ArrayBuffer);
      const { xml } = await kfbContainerToXml(container, getKfbKeys());
      return xml;
    } catch (error) {
      console.warn('[TextAssetLoader] KFB 解密失败，回退为原始文本', error);
      return null;
    }
  }

  override canExport(): boolean {
    return true;
  }

  override async export(dataHandler?: RepoDataHandler): Promise<AssetExportItem[] | null> {
    const data = dataHandler ? await dataHandler(this.object.data) : this.object.data;
    const kfbXml = this.isKfb() ? await this.tryKfbXml() : null;
    if (kfbXml) {
      return [
        {
          name: `${this.objNameForFile}.xml`,
          blob: new Blob([kfbXml], { type: 'application/xml' }),
        },
      ];
    }
    if (isJSON(data)) {
      return [
        {
          name: `${this.objNameForFile}.json`,
          blob: new Blob([data], { type: 'application/json' }),
        },
      ];
    }
    return [
      {
        name: `${this.objNameForFile}.txt`,
        blob: new Blob([data as BlobPart], { type: 'text/plain' }),
      },
    ];
  }

  override getPreviewDetail(): PreviewDetail {
    return { type: PreviewType.Text, canEdit: true, kfbContainer: this.isKfb() };
  }

  override async getPreviewData(payload?: any, dataHandler?: RepoDataHandler) {
    const data = dataHandler ? await dataHandler(this.object.data) : this.object.data;
    if (this.isKfb()) {
      const xml = await this.tryKfbXml();
      if (xml !== null) return xml;
    }
    if (isData(data)) {
      return TextAssetLoader.textDecoder.decode(data);
    }
    return isString(data) ? data : String(data);
  }
}