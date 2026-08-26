/**
 * KFB 编解码封装层（Vite/浏览器入口）：?raw 内联资源，转发到 kfbCodecCore。
 * 资源用动态 import 拆分独立 chunk —— 8.7MB schema 只在首次使用 KFB 功能时加载，
 * 不进首页主 bundle。
 */

import {
  decodeKfb as coreDecode,
  encodeKfb as coreEncode,
  kfbRootType as coreRootType,
  type KfbDecodedViews,
  type KfbInputFormat,
  type KfbResources,
} from './kfbCodecCore';

let resourcesPromise: Promise<KfbResources> | null = null;

function getResources(): Promise<KfbResources> {
  if (!resourcesPromise) {
    resourcesPromise = Promise.all([
      import('../kfb/kfb_schema_decoder.js?raw'),
      import('../kfb/kfb_readable_adapter.js?raw'),
      import('../kfb/kfb_schema.json?raw'),
      import('../kfb/kfb_dump_layout.json?raw'),
    ]).then(([d, a, s, l]) => ({
      decoderSrc: d.default,
      adapterSrc: a.default,
      schemaRaw: s.default,
      layoutRaw: l.default,
    }));
  }
  return resourcesPromise;
}

export async function decodeKfb(buffer: Uint8Array): Promise<KfbDecodedViews> {
  return coreDecode(buffer, await getResources());
}

export async function encodeKfb(text: string, format: KfbInputFormat): Promise<Uint8Array> {
  return coreEncode(text, format, await getResources());
}

export async function kfbRootType(): Promise<string> {
  return coreRootType(await getResources());
}
