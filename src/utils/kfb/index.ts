/**
 * KFB 语义层统一入口（Schema 懒加载 + 容器↔XML 编解码）。
 * 全部为纯函数/异步，worker 与主线程均可用。
 * schema/layout JSON 较大（约 9MB），使用动态 import 拆包、按需加载。
 */
import { normalizeSchema, decodeKfb, encodeKfb } from './kfbSchemaDecoder';
import { semanticToLegacyXml, legacyXmlToSemantic, anyJsonToSemantic } from './kfbReadableAdapter';
import { decryptKfbContainerAuto, encryptKfbContainer } from './kfbBundle';

export * from './kfbBundle';
export { normalizeSchema, decodeKfb, encodeKfb, runSyntheticSelfTest } from './kfbSchemaDecoder';
export { semanticToLegacyXml, legacyXmlToSemantic, anyJsonToSemantic, detectJsonFormat } from './kfbReadableAdapter';
export { setKfbKeys, getKfbKeys } from './keys';

let _schemaPromise: Promise<any> | null = null;
let _layoutPromise: Promise<any> | null = null;

async function loadSchemaJson(): Promise<any> {
  if (!_schemaPromise) {
    _schemaPromise = import('@/assets/kfb/kfb_schema.json').then((m) => m.default ?? m);
  }
  return _schemaPromise;
}

async function loadLayoutJson(): Promise<any> {
  if (!_layoutPromise) {
    _layoutPromise = import('@/assets/kfb/kfb_dump_layout.json').then((m) => m.default ?? m);
  }
  return _layoutPromise;
}

export interface KfbMeta {
  key: string;
  /** 容器前 4 字节（保留原样写回） */
  header: Uint8Array;
  /** 16 字节 AES-CTR counter 块（= 容器 [4:20]） */
  counter: Uint8Array;
}

/** 加载并规范化 KFB schema（懒加载，只初始化一次） */
export function loadKfbSchema(): Promise<any> {
  if (!_schemaPromise) {
    _schemaPromise = loadSchemaJson().then((raw) => normalizeSchema(raw));
  }
  return _schemaPromise;
}

/** 解析语义：XML 或语义 JSON → semantic JSON */
export async function kfbToSemantic(content: string, schema: any): Promise<any> {
  const trimmed = content.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('<')) {
    return legacyXmlToSemantic(content, schema);
  }
  const layout = await loadLayoutJson();
  return anyJsonToSemantic(JSON.parse(content), schema, layout);
}

/** 语义 JSON → 明文 KFB 二进制 */
export function semanticToKfbBytes(semantic: any, schema: any): Uint8Array {
  return encodeKfb(semantic, schema);
}

/** 容器 → XML（可读 legacy XML），返回使用的密钥与 semantic */
export async function kfbContainerToXml(
  container: Uint8Array,
  keyList: string[],
): Promise<{ xml: string; key: string; semantic: any }> {
  const { plain, key } = await decryptKfbContainerAuto(container, keyList);
  const schema = await loadKfbSchema();
  const decoded = decodeKfb(plain, schema);
  const xml = semanticToLegacyXml(decoded.semantic, schema);
  return { xml, key, semantic: decoded.semantic };
}

/** XML / JSON → 加密容器（复用原容器 header+counter） */
export async function kfbContentToContainer(content: string, meta: KfbMeta): Promise<Uint8Array> {
  const schema = await loadKfbSchema();
  const semantic = await kfbToSemantic(content, schema);
  const plain = semanticToKfbBytes(semantic, schema);
  return encryptKfbContainer(plain, meta.key, meta.header, meta.counter);
}