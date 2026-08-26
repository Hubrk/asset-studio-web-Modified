/**
 * KFB 编解码核心（B 环节）：明文 .kfb 二进制 ⇄ semantic JSON / runtime JSON / legacy XML。
 *
 * 资源（decoder/adapter JS 源码 + schema/dump_layout JSON 文本）由调用方注入：
 *   - 浏览器/Vite：kfbCodec.ts 用 ?raw import 后传入
 *   - Node 测试：fs.readFileSync 读入后传入
 *
 * 底层是原 Android 工具 assets/kfb/ 里那套纯 JS 编解码器，机制与原 codec.html 的 mod() 一致：
 * 两个 JS 是 CommonJS（module.exports），用 new Function('require','module','exports', src)
 * 在模块作用域执行，node:fs/node:path/node:crypto 用 stub 顶替。
 */

export type KfbInputFormat = 'xml' | 'runtime' | 'semantic';

export interface KfbDecodedViews {
  /** 带类型树语义的完整 JSON（可直接编辑战斗数值） */
  semantic: string;
  /** 可读性优化 JSON（字段名带 dump.cs 内存偏移，如 "Int32 index @0x14"） */
  runtime: string;
  /** 旧版 AnimationData 兼容 XML */
  xml: string;
}

export interface KfbResources {
  decoderSrc: string;
  adapterSrc: string;
  schemaRaw: string;
  layoutRaw: string;
}

interface DecoderModule {
  normalizeSchema(raw: unknown): unknown;
  decodeKfb(buffer: Uint8Array, schema: unknown): { semantic: unknown; ast: unknown; coverage: unknown };
  encodeKfb(semantic: unknown, schema: unknown): Uint8Array;
  toXml(decoded: unknown, rootType: string, inputHash?: string): string;
}

interface AdapterModule {
  semanticToRuntimeJson(semantic: unknown, schema: unknown, layout: unknown): unknown;
  runtimeJsonToSemantic(doc: unknown, schema: unknown, layout: unknown): unknown;
  semanticToLegacyXml(semantic: unknown, schema: unknown, inputHash?: string): string;
  legacyXmlToSemantic(raw: string, schema: unknown): unknown;
  detectJsonFormat(doc: unknown): 'runtime-json' | 'semantic-json' | 'unknown';
}

/**
 * 注入 Buffer polyfill（仅浏览器/Worker 需要；Node 已有原生 Buffer）。
 * 与原 Android 工具 codec.html 的 polyfill 一致，另补 readUInt 系列（decoder 用了 readUInt32LE，
 * codec.html 原版缺失——潜在边界坑）。
 */
function installBufferPolyfill(): void {
  const g = globalThis as { Buffer?: unknown };
  if (typeof g.Buffer !== 'undefined') return;
  class KfbBuffer extends Uint8Array {
    static from(v: unknown, enc?: unknown): KfbBuffer {
      if (typeof v === 'string') return new KfbBuffer(new TextEncoder().encode(v));
      if (v instanceof ArrayBuffer) return new KfbBuffer(v.slice(0));
      return new KfbBuffer(v as ArrayLike<number>);
    }
    static allocUnsafe(n: number): KfbBuffer {
      return new KfbBuffer(n);
    }
    static alloc(n: number): KfbBuffer {
      return new KfbBuffer(n);
    }
    static isBuffer(v: unknown): boolean {
      return v instanceof KfbBuffer;
    }
    static concat(list: readonly Uint8Array[]): KfbBuffer {
      let n = 0;
      for (const x of list) n += x.length;
      const r = new KfbBuffer(n);
      let p = 0;
      for (const x of list) {
        r.set(x, p);
        p += x.length;
      }
      return r;
    }
    static byteLength(v: unknown): number {
      return typeof v === 'string' ? new TextEncoder().encode(v).length : (v as ArrayLike<unknown>).length;
    }
    subarray(a?: number, b?: number): KfbBuffer {
      return new KfbBuffer(super.subarray(a, b));
    }
    toString(enc = 'utf8'): string {
      if (enc === 'hex') return Array.from(this, x => x.toString(16).padStart(2, '0')).join('');
      return new TextDecoder(enc === 'ascii' ? 'utf-8' : enc).decode(this);
    }
    copy(target: Uint8Array, tStart = 0, sStart = 0, sEnd = this.length): number {
      target.set(this.subarray(sStart, sEnd), tStart);
      return sEnd - sStart;
    }
    private dv(): DataView {
      return new DataView(this.buffer, this.byteOffset, this.byteLength);
    }
    readFloatLE(p = 0): number {
      return this.dv().getFloat32(p, true);
    }
    writeFloatLE(v: number, p = 0): number {
      this.dv().setFloat32(p, v, true);
      return p + 4;
    }
    readDoubleLE(p = 0): number {
      return this.dv().getFloat64(p, true);
    }
    writeDoubleLE(v: number, p = 0): number {
      this.dv().setFloat64(p, v, true);
      return p + 8;
    }
    readUInt32LE(p = 0): number {
      return this.dv().getUint32(p, true);
    }
    readUInt16LE(p = 0): number {
      return this.dv().getUint16(p, true);
    }
    readUInt8(p = 0): number {
      return this.dv().getUint8(p);
    }
    readInt32LE(p = 0): number {
      return this.dv().getInt32(p, true);
    }
  }
  g.Buffer = KfbBuffer;
}

/** 加载 CommonJS 模块（node:* stub 与原 codec.html 一致） */
function loadCommonJs<T>(src: string): T {  const module = { exports: {} as T };
  const requireFn = (name: string): unknown => {
    if (name === 'node:fs' || name === 'fs') {
      return {
        existsSync: () => false,
        readFileSync: () => {
          throw new Error('asset fs unavailable');
        },
      };
    }
    if (name === 'node:path' || name === 'path') return { resolve: (x: string) => x };
    if (name === 'node:crypto' || name === 'crypto') {
      return {
        createHash: () => ({
          update: () => ({ digest: () => '' }),
        }),
      };
    }
    throw new Error(`unsupported module ${name}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', src)(requireFn, module, module.exports);
  return module.exports;
}

interface KfbContext {
  decoder: DecoderModule;
  adapter: AdapterModule;
  schema: unknown;
  layout: unknown;
  rootType: string;
}

const ctxCache = new WeakMap<KfbResources, KfbContext>();

function ensureLoaded(res: KfbResources): KfbContext {
  installBufferPolyfill();
  const cached = ctxCache.get(res);
  if (cached) return cached;
  const decoder = loadCommonJs<DecoderModule>(res.decoderSrc);
  const adapter = loadCommonJs<AdapterModule>(res.adapterSrc);
  const schemaRawObj = JSON.parse(res.schemaRaw);
  const layout = JSON.parse(res.layoutRaw);
  const schema = decoder.normalizeSchema(schemaRawObj);
  const ctx: KfbContext = {
    decoder,
    adapter,
    schema,
    layout,
    rootType: (schemaRawObj as { root_type?: string }).root_type || 'KH.ActorData',
  };
  ctxCache.set(res, ctx);
  return ctx;
}

/** 明文 .kfb → 三个可编辑视图（字符串）。 */
export function decodeKfb(buffer: Uint8Array, res: KfbResources): KfbDecodedViews {
  const ctx = ensureLoaded(res);
  // decoder 要求 Buffer 实例（Buffer.isBuffer 校验）
  const g = globalThis as { Buffer: { isBuffer(v: unknown): boolean; from(v: unknown): Uint8Array } };
  const buf = g.Buffer.isBuffer(buffer) ? (buffer as Uint8Array) : g.Buffer.from(buffer);
  const decoded = ctx.decoder.decodeKfb(buf, ctx.schema);
  if (!decoded?.semantic) throw new Error('KFB 解码失败：无 semantic 结果');
  // semanticToRuntimeJson 返回对象（codec.html 里 JSON.stringify 后才传出去）
  const runtime = JSON.stringify(ctx.adapter.semanticToRuntimeJson(decoded.semantic, ctx.schema, ctx.layout), null, 2);
  const xml = ctx.adapter.semanticToLegacyXml(decoded.semantic, ctx.schema, '');
  return {
    semantic: JSON.stringify(decoded.semantic, null, 2),
    runtime,
    xml,
  };
}

/** 编辑后的文本 → 明文 .kfb（带回读验证，与 Android 端一致）。 */
export function encodeKfb(text: string, format: KfbInputFormat, res: KfbResources): Uint8Array {
  const ctx = ensureLoaded(res);
  const raw = text.replace(/^\uFEFF/, '');
  let semantic: unknown;
  if (format === 'xml') {
    semantic = ctx.adapter.legacyXmlToSemantic(raw, ctx.schema);
  } else {
    const doc = JSON.parse(raw);
    if (format === 'runtime' || ctx.adapter.detectJsonFormat(doc) === 'runtime-json') {
      semantic = ctx.adapter.runtimeJsonToSemantic(doc, ctx.schema, ctx.layout);
    } else {
      semantic = doc;
    }
  }
  const out = ctx.decoder.encodeKfb(semantic, ctx.schema);
  const check = ctx.decoder.decodeKfb(out, ctx.schema);
  if (!check?.semantic) throw new Error('KFB 回读验证失败');
  return out;
}

/** 获取语义 JSON 的根类型名（用于展示） */
export function kfbRootType(res: KfbResources): string {
  return ensureLoaded(res).rootType;
}
