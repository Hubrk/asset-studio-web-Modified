/**
 * KFB 加密 AssetBundle 解密 / 回加密（TS 移植，源：KfbBundleTool.java 反编译）
 *
 * 链路（A 环节）：
 *   .assetbundle (UnityFS / UnityKHFS / UnityKHNFS / UnityKH1FS)
 *     → parse():  读头 + khCrypt 解 BlockInfo + LZ4 解压数据块 → 逻辑字节流 b.data
 *     → find():   在 dirs 数据块里扫 [le32 len][name][align4][le32 len][script] 模式，
 *                 逐个试 decryptContainer 命中 TextAsset（cls==49）
 *     → decryptContainer(): AES-256-CTR + LZ4 解压 → 明文 .kfb 字节
 *   回写（A4-A6）：
 *     encryptContainer(明文) → rebuildSerialized(重写对象表) → build(重建 UnityFS/UnityKH + crcFix)
 *
 * 密钥：K0/K1 是 UnityKH 头加密密钥（硬编码），AES-256 key 由用户输入 64 hex。
 * 依赖：WebCrypto（AES-CTR），Node ≥18 / 浏览器均可用；LZ4 / khCrypt / CRC32 手写。
 */

// ---------- 常量 ----------

const K0 = 'X@85Pq!6v$lCt7UYsihH3!cPb1P71bo4lX59FXqY!VO$YiYsu!Keu3aVZwi5on5l';
const K1 = 'hAi5luE8FlyblDdCTQC9uxnj3rkNwd1swrKI7Mx1aDFEe2B5h#3X&s54%GuSeHf@';
const K0_BYTES = new TextEncoder().encode(K0);
const K1_BYTES = new TextEncoder().encode(K1);

// ---------- 类型 ----------

export interface KfbDir {
  off: number;
  size: number;
  flags: number;
  name: string;
}

export interface KfbBundle {
  data: Uint8Array; // 解压后的逻辑字节流（SerializedFile）
  dirs: KfbDir[];
  flags: number;
  kh: number; // -1 标准 UnityFS；0 UnityKHFS；1 UnityKHNFS；2 UnityKH1FS
  revision: string;
  signature: string;
  unity: string;
  version: number;
}

export interface KfbHit {
  dir: KfbDir;
  iv: Uint8Array; // 16B，来自容器 [4B 外层头][16B IV][密文]
  name: string;
  objectOffset: number; // TextAsset 名字在解压数据里的偏移（用于匹配 SerializedFile 对象）
  outer: Uint8Array; // 容器前 4B 外层头，原样保留
  scriptLen: number;
  scriptOffset: number;
}

export interface KfbExtracted {
  name: string;
  plain: Uint8Array;
  candidates: number;
}

export interface KfbEncryptOptions {
  crcTarget?: number; // 缺省 = 原数据 CRC（crcFix 使新数据 CRC32 命中该值）
  unityFs?: boolean; // 输出标准 UnityFS（推荐）；false 则按原 kh 签名回包
}

// ---------- 字节工具（Java int/long 语义，JS 位运算天然 32 位有符号） ----------

function be16(a: Uint8Array, p: number): number {
  return ((a[p] & 255) << 8) | (a[p + 1] & 255);
}
function be32(a: Uint8Array, p: number): number {
  return ((a[p] & 255) << 24) | ((a[p + 1] & 255) << 16) | ((a[p + 2] & 255) << 8) | (a[p + 3] & 255);
}
function be64(a: Uint8Array, p: number): number {
  return be32(a, p) * 4294967296 + (be32(a, p + 4) >>> 0);
}
function le32(a: Uint8Array, p: number): number {
  return (a[p] & 255) | ((a[p + 1] & 255) << 8) | ((a[p + 2] & 255) << 16) | (a[p + 3] << 24);
}
function be2(v: number): Uint8Array {
  return new Uint8Array([(v >>> 8) & 255, v & 255]);
}
function be4(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
}
function be8(v: number): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = v & 255;
    v = Math.floor(v / 256);
  }
  return b;
}
function le4(v: number): Uint8Array {
  return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
}
function slice(a: Uint8Array, p: number, n: number): Uint8Array {
  // 注意：Node 的 Buffer.slice() 返回共享内存 view（非拷贝），而 rotate/xor 会原地写，
  // 共享 view 会导致写回互相污染。强制走 Uint8Array 的拷贝语义。
  return Uint8Array.prototype.slice.call(a, p, p + n) as Uint8Array;
}
function concat(...xs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const x of xs) n += x.length;
  const r = new Uint8Array(n);
  let p = 0;
  for (const x of xs) {
    r.set(x, p);
    p += x.length;
  }
  return r;
}
/** 找 null 终止位置（Java z()） */
function z(a: Uint8Array, p: number): number {
  while (p < a.length && a[p] !== 0) p++;
  return p;
}
/** 读 null 终止字符串（Java cs()） */
function cs(a: Uint8Array, p: number): string {
  const e = z(a, p);
  return new TextDecoder().decode(a.subarray(p, e));
}
function i(a: Uint8Array, p: number, le: boolean): number {
  return le ? le32(a, p) : be32(a, p);
}
function l(a: Uint8Array, p: number, le: boolean): number {
  const x = i(a, p, le) >>> 0;
  const y = i(a, p + 4, le) >>> 0;
  return le ? y * 4294967296 + x : x * 4294967296 + y;
}
function put32(a: Uint8Array, p: number, v: number, le: boolean): void {
  a.set(le ? le4(v) : be4(v), p);
}
function put64(a: Uint8Array, p: number, v: number, le: boolean): void {
  if (!le) {
    a.set(be8(v), p);
  } else {
    a.set(le4(v), p);
    a.set(le4(Math.floor(v / 4294967296)), p + 4);
  }
}
function putBe32(a: Uint8Array, p: number, v: number): void {
  a.set(be4(v), p);
}
function putBe64(a: Uint8Array, p: number, v: number): void {
  a.set(be8(v), p);
}
const align4 = (x: number) => (x + 3) & ~3;
const align16 = (x: number) => (x + 15) & ~15;
function padLen(len: number, n: number): Uint8Array {
  return new Uint8Array((n - (len % n)) % n);
}
function pad(a: Uint8Array, n: number): Uint8Array {
  return concat(a, padLen(a.length, n));
}

// ---------- CRC32（zlib 语义，Java CRC32 一致） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(a: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < a.length; i++) c = CRC_TABLE[(c ^ a[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) | 0; // Java int（可负）
}

// ---------- AES-256-CTR（WebCrypto，与 Java AES/CTR/NoPadding 兼容） ----------

async function aesCtr(
  data: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
  encrypt: boolean,
): Promise<Uint8Array> {
  const algo = { name: 'AES-CTR', counter: iv as BufferSource, length: 128 } as const;
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'AES-CTR' },
    false,
    encrypt ? ['encrypt'] : ['decrypt'],
  );
  const out = encrypt
    ? await crypto.subtle.encrypt(algo, key, data as BufferSource)
    : await crypto.subtle.decrypt(algo, key, data as BufferSource);
  return new Uint8Array(out);
}

// ---------- LZ4 ----------

/**
 * LZ4 block 解压（标准语义，参考 Java 实现；JADX 在扩展链处丢失 break，
 * 此处按 LZ4 规范重写：literalLen/matchLen 的 255 扩展链，读到 <255 即停）。
 * 输出长度为 n（调用方已知）。
 */
function lz4Decompress(x: Uint8Array, n: number): Uint8Array {
  if (n < 0 || n > 0x40000000) throw new Error(`LZ4 解压尺寸无效: ${n}`);
  const o = new Uint8Array(n);
  let t = 0; // 输入游标
  let p = 0; // 输出游标
  // Unity 引擎在 LZ4 数据块末尾会额外填充字节（尾部 padding），因此压缩流
  // 实际内容可能比声明的 n 略短。解码时以声明大小 n 为界：一旦产满 n 字节
  // 立即停止解析，不再读取尾部填充，否则会把填充当 token 导致越界。
  while (t < x.length) {
    if (p >= n) break; // 已产满声明大小，忽略尾部填充
    const token = x[t] & 255;
    let v = t + 1;
    // 字面量长度
    let litLen = token >>> 4;
    if (litLen === 15) {
      for (;;) {
        if (v >= x.length) throw new Error('LZ4 截断');
        const b = x[v++] & 255;
        litLen += b;
        if (b !== 255) break;
      }
    }
    if (p + litLen > n) litLen = n - p; // 截断到声明大小
    if (v + litLen > x.length || p + litLen > n) throw new Error('LZ4 字面量无效');
    o.set(x.subarray(v, v + litLen), p);
    v += litLen;
    p += litLen;
    if (v === x.length || p >= n) break; // 数据结束（无 match）
    if (v + 2 > x.length) throw new Error('LZ4 回溯截断');
    const off = (x[v] & 255) | ((x[v + 1] & 255) << 8);
    v += 2;
    // 匹配长度
    let m = (token & 15) + 4;
    if ((token & 15) === 15) {
      for (;;) {
        if (v >= x.length) throw new Error('LZ4 截断');
        const b = x[v++] & 255;
        m += b;
        if (b !== 255) break;
      }
    }
    if (p + m > n) m = n - p; // 截断到声明大小
    if (off === 0 || off > p || p + m > n) throw new Error('LZ4 数据块无效');
    for (let q = 0; q < m; q++) o[p] = o[p - off], p++;
    t = v;
  }
  return o.slice(0, Math.min(p, n));
}

/**
 * LZ4 raw-block 假压缩：不压缩，直接 [4B 原长 LE][token 0xF0][255 扩展链][原始字节]。
 * 与 Java lz4Store 逐字节一致（游戏端 LZ4 解压器可解）。
 */
function lz4Store(a: Uint8Array): Uint8Array {
  const head: number[] = [
    a.length & 255,
    (a.length >>> 8) & 255,
    (a.length >>> 16) & 255,
    (a.length >>> 24) & 255,
    Math.min(15, a.length) << 4,
  ];
  let r = Math.max(0, a.length - 15);
  while (r >= 255) {
    head.push(255);
    r -= 255;
  }
  if (a.length >= 15) head.push(r);
  const out = new Uint8Array(head.length + a.length);
  out.set(head, 0);
  out.set(a, head.length);
  return out;
}

// ---------- khCrypt（UnityKH 头加密） ----------

function xor(a: Uint8Array, k: Uint8Array): void {
  for (let i = 0; i < a.length; i++) a[i] ^= k[i % k.length];
}
function size8(v: number): Uint8Array {
  return be8(v >>> 0);
}
function rotateRight(a: Uint8Array, off: number, len: number, shift: number): void {
  const s = shift % len;
  if (len >= 2 && s !== 0) {
    const t = slice(a, off + len - s, s);
    a.copyWithin(off + s, off, off + len - s);
    a.set(t, off);
  }
}
function rotateLeft(a: Uint8Array, off: number, len: number, shift: number): void {
  const s = shift % len;
  if (len >= 2 && s !== 0) {
    const t = slice(a, off, s);
    a.copyWithin(off, off + s, off + len);
    a.set(t, off + len - s);
  }
}

/**
 * UnityKH BlockInfo 加/解密。
 * v0: XOR K0；v1: XOR size ⊕ XOR K1（方向不同）；v2: rotate + XOR(K0/K1 by block%3/5/7) + XOR size。
 */
function khCrypt(a: Uint8Array, block: number, v: number, enc: boolean): Uint8Array {
  const r = Uint8Array.prototype.slice.call(a) as Uint8Array;
  if (v === 0) {
    xor(r, K0_BYTES);
    return r;
  }
  if (v === 1) {
    if (enc) {
      xor(r, size8(block));
      xor(r, K1_BYTES);
    } else {
      xor(r, K1_BYTES);
      xor(r, size8(block));
    }
    return r;
  }
  if (v !== 2) throw new Error(`不支持 UnityKH 版本: ${v}`);
  const len = r.length;
  if (len === 0) throw new Error('UnityKH BlockInfo 为空');
  let al = ((len % 7) + 7) % len;
  if (al === 0) al = len;
  const key = block % 3 === 0 || block % 5 === 0 || block % 7 === 0 ? K1_BYTES : K0_BYTES;
  let shift = ((len % 7) + 7) % len;
  if (shift === 0) shift = len;
  let end = ((len % 7) + 1) % al;
  if (end === 0) end = al;
  if (enc) {
    rotateLeft(r, 0, len, end);
    for (let p = 0; p < len; p += al) rotateLeft(r, p, Math.min(al, len - p), end);
    xor(r, size8(block));
    xor(r, key);
    rotateLeft(r, 0, len, shift);
  } else {
    rotateRight(r, 0, len, shift);
    xor(r, key);
    xor(r, size8(block));
    for (let p = 0; p < len; p += al) rotateRight(r, p, Math.min(al, len - p), end);
    rotateRight(r, 0, len, end);
  }
  return r;
}

// ---------- KFB 容器（TextAsset 内容） ----------

/** 容器 = [4B 外层头][16B IV][AES-256-CTR 密文]；明文 = [4B LZ4 解压长度 LE][LZ4 块] */
async function decryptContainer(c: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (c.length <= 20) throw new Error('KFB 容器过短');
  const plain = await aesCtr(slice(c, 20, c.length - 20), key, slice(c, 4, 16), false);
  if (plain.length >= 5) {
    return lz4Decompress(slice(plain, 4, plain.length - 4), le32(plain, 0));
  }
  throw new Error('KFB LZ4 数据无效');
}

async function encryptContainer(
  p: Uint8Array,
  key: Uint8Array,
  header: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cipher = await aesCtr(lz4Store(p), key, iv, true);
  return concat(header, iv, cipher);
}

// ---------- Bundle 解析 ----------

function parseKey(text: string): Uint8Array {
  const t = (text ?? '').trim();
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error('AES-256 Key 必须是 64 位十六进制字符串');
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = parseInt(t.substring(i * 2, i * 2 + 2), 16);
  return r;
}

/**
 * 解析 UnityFS / UnityKH 系头，产出逻辑字节流 b.data（BlockInfo 已 khCrypt 解密、数据块已解压）。
 * UnityKH 包装会被还原成标准 UnityFS 布局再走同一解析。
 */
function parse(inBytes: Uint8Array): KfbBundle {
  const sigEnd = z(inBytes, 0);
  const sig = new TextDecoder().decode(inBytes.subarray(0, sigEnd));
  let kh = -1;
  if (sig === 'UnityKHFS') kh = 0;
  else if (sig === 'UnityKHNFS') kh = 1;
  else if (sig === 'UnityKH1FS') kh = 2;
  else if (sig !== 'UnityFS') throw new Error(`不支持的 Bundle: ${sig}`);

  let a = inBytes;
  if (kh >= 0) {
    const p = sigEnd + 31;
    const n = be32(inBytes, p);
    const p2 = p + (kh === 0 ? 12 : 11) + 12;
    if (n <= 0 || p2 + n > inBytes.length) throw new Error('UnityKH BlockInfo 无效');
    const info = khCrypt(slice(inBytes, p2, n), n, kh, false);
    const prefix = new TextEncoder().encode('UnityFS');
    a = concat(
      prefix,
      slice(inBytes, sigEnd, 31),
      slice(inBytes, sigEnd + 31, 12),
      new Uint8Array(14),
      info,
      slice(inBytes, p2 + n, inBytes.length - p2 - n),
    );
  }

  const p3 = z(a, 0) + 1;
  const b: KfbBundle = {
    signature: sig,
    kh,
    version: be32(a, p3),
    unity: cs(a, p3 + 4),
    revision: '',
    flags: 0,
    dirs: [],
    data: new Uint8Array(),
  };
  const p4 = p3 + 4;
  const p5 = z(a, p4) + 1;
  b.revision = cs(a, p5);
  const p6 = z(a, p5) + 1;
  const declared = be64(a, p6);
  const p7 = p6 + 8;
  const ci = be32(a, p7);
  const p8 = p7 + 4;
  const ui = be32(a, p8);
  const p9 = p8 + 4;
  b.flags = be32(a, p9);
  let p10 = p9 + 4;
  if (declared < 0 || declared > a.length) throw new Error('UnityFS 文件尺寸无效');
  if (b.version >= 7 || (b.flags & 512) !== 0) p10 = align16(p10);
  const infoAt0 = (b.flags & 128) !== 0 ? declared - ci : p10;
  if (infoAt0 < 0 || infoAt0 + ci > a.length) throw new Error('BlockInfo 截断');
  const info2 = decomp(slice(a, infoAt0, ci), ui, b.flags & 63);

  // 数据块表
  const n2 = be32(info2, 16);
  let q = 20;
  const un: number[] = [];
  const co: number[] = [];
  const fl: number[] = [];
  for (let k = 0; k < n2; k++) {
    un.push(be32(info2, q));
    co.push(be32(info2, q + 4));
    fl.push(be16(info2, q + 8));
    q += 10;
  }
  // 目录
  const dn = be32(info2, q);
  q += 4;
  for (let k = 0; k < dn; k++) {
    const o = be64(info2, q);
    const s = be64(info2, q + 8);
    const f = be32(info2, q + 16);
    const q3 = q + 20;
    const name = cs(info2, q3);
    b.dirs.push({ off: o, size: s, flags: f, name });
    q = z(info2, q3) + 1;
  }
  // 数据
  const infoAt = infoAt0;
  const dp0 = (b.flags & 128) !== 0 ? p10 : p10 + ci;
  let dp = (b.flags & 128) === 0 && (b.flags & 512) !== 0 ? align16(dp0) : dp0;
  const dataEnd = (b.flags & 128) !== 0 ? infoAt : declared;
  const parts: Uint8Array[] = [];
  for (let k = 0; k < n2; k++) {
    if (dp + co[k] > dataEnd) throw new Error('数据块截断');
    parts.push(decomp(slice(a, dp, co[k]), un[k], fl[k] & 63));
    dp += co[k];
  }
  b.data = concat(...parts);
  return b;
}

function decomp(x: Uint8Array, n: number, type: number): Uint8Array {
  if (type === 0) {
    if (x.length !== n) throw new Error('未压缩块长度错误');
    return x;
  }
  if (type === 2 || type === 3) return lz4Decompress(x, n);
  throw new Error(`不支持压缩类型: ${type}`);
}

// ---------- 查找 TextAsset ----------

/** 在 dirs 数据块里扫候选 TextAsset，逐个试解密；wanted 为空则收集全部命中名。 */
async function find(b: KfbBundle, wanted: string | null, key: Uint8Array): Promise<KfbHit[]> {
  const out: KfbHit[] = [];
  for (const d of b.dirs) {
    if (d.off < 0 || d.size < 0 || d.off + d.size > b.data.length) continue;
    const a = slice(b.data, d.off, d.size);
    for (let p = 0; p + 12 <= a.length; p++) {
      const n = le32(a, p);
      if (n < 1 || n > 160) continue;
      if (p + 4 + n > a.length) continue;
      const name = new TextDecoder().decode(a.subarray(p + 4, p + 4 + n));
      if (!/^[A-Za-z0-9_.\-/]{1,160}$/.test(name)) continue;
      if (wanted != null && wanted.trim() !== '' && name !== wanted.trim()) continue;
      const q = align4(p + 4 + n);
      if (q + 4 > a.length) continue;
      const len = le32(a, q);
      const so = q + 4;
      if (len <= 20 || so + len > a.length) continue;
      const x = slice(a, so, len);
      try {
        const plain = await decryptContainer(x, key);
        if (plain.length > 0) {
          out.push({
            dir: d,
            objectOffset: p,
            scriptOffset: so,
            scriptLen: len,
            name,
            outer: slice(x, 0, 4),
            iv: slice(x, 4, 16),
          });
        }
      } catch {
        // 解密失败 → 不是目标
      }
    }
  }
  return out;
}

// ---------- SerializedFile 对象表重写 ----------

interface SerializedObj {
  idx: number;
  start: number; // 旧偏移（数据区内相对 dataOff）
  size: number;
  startOffset: number;
  sizeOffset: number;
  target: boolean;
  cls: number;
  newStart?: number;
  newSize?: number;
}

/**
 * 重写 Unity SerializedFile：定位 TextAsset 对象（classId==49），替换其 m_Script 字节，
 * 重排对象（8B 对齐）并回写 start/size 偏移，更新文件长度。支持 ver<22（32 位偏移）与 >=22（64 位）。
 */
function rebuildSerialized(a: Uint8Array, h: KfbHit, script: Uint8Array): Uint8Array {
  // 标准 Unity SerializedFile 头（v22，前 4 字段大端、后字段按 endianness）：
  //   [0..4) metadataSize(BE) [4..8) fileSize(BE) [8..12) version(BE) [12..16) dataOffset(BE)
  //   [16] endianness [20..24) metadataSize [24..32) fileSize(u64) [32..40) dataOffset(u64) [48..) unityVersion
  // 本游戏 bundle 实测：version=22、metadataSize(LE@20)=2545、dataOffset(LE@32)=4096。
  const ver = be32(a, 8);
  const le = (a[16] & 255) === 0;
  const dataOff = ver >= 22 ? be64(a, 32) : be32(a, 12);
  const meta = ver >= 22 ? 48 : 20;
  const metaSize = ver >= 22 ? be32(a, 20) : be32(a, 0);
  const metaEnd = meta + metaSize;
  if (dataOff < metaEnd || dataOff > a.length) throw new Error('SerializedFile 无效');

  let p = z(a, meta) + 1 + 4; // m_ObjectHideFlags(int32)
  const tree = a[p] !== 0;
  p += 1;
  const tc = i(a, p, le);
  p += 4;
  const cls: number[] = [];
  for (let x = 0; x < tc; x++) {
    cls.push(i(a, p, le));
    let p4 = p + 7;
    if (ver >= 21) {
      if (cls[x] === 114) p4 += 16;
      p = p4 + 16;
    } else {
      p = p4 + 16;
    }
    if (tree) {
      const nn = i(a, p, le);
      const ss = i(a, p + 4, le);
      p += (ver >= 19 ? 32 : 24) * nn + 8 + ss;
    }
    if (ver >= 21) {
      const dc = i(a, p, le);
      p += dc * 4 + 4;
    }
  }
  const oc = i(a, p, le);
  let p5 = p + 4;
  const objs: SerializedObj[] = [];
  for (let x = 0; x < oc; x++) {
    if (ver >= 14) p5 = align4(p5);
    const p6 = p5 + (ver >= 14 ? 8 : 4); // m_PathID
    const st = ver >= 22 ? l(a, p6, le) : i(a, p6, le) >>> 0;
    const p7 = p6 + (ver >= 22 ? 8 : 4);
    const sz = i(a, p7, le);
    const p8 = p7 + 4;
    const typ = i(a, p8, le);
    let p9 = p8 + 4;
    if (ver < 16) p9 += 2;
    if (ver >= 11 && ver < 17) p9 += 2;
    // 注意：JADX 反编译的 Java 原版有无条件 p9++（丢失了 ver==15 的条件分支），
    // 会让 v22 对象表项偏移 1 字节（下一对象的 bytesStart 读到垃圾）。
    // v22 对象表项为 24B（pathID 8 + bytesStart 8 + size 4 + type 4），不加 1。
    const o: SerializedObj = {
      idx: x,
      start: st,
      size: sz,
      startOffset: p6,
      sizeOffset: p7,
      target: dataOff + st === h.objectOffset,
      cls: typ < 0 || typ >= cls.length ? -1 : cls[typ],
    };
    objs.push(o);
    p5 = p9;
  }

  let tar: SerializedObj | null = null;
  for (const o of objs) if (o.target) tar = o;
  if (tar == null || tar.cls !== 49) throw new Error('未找到 TextAsset 对象');
  if (h.scriptOffset - 4 < tar.start + dataOff || h.scriptOffset + h.scriptLen > tar.start + dataOff + tar.size) {
    throw new Error('TextAsset 范围无效');
  }

  const before = h.scriptOffset - 4 - (tar.start + dataOff);
  const newObj = concat(slice(a, tar.start + dataOff, before), le4(script.length), script);
  const newObj2 = pad(newObj, 4);
  // 重排对象（8B 对齐）；tar 用新脚本字节，其余原样搬（注意 start 仍是旧偏移）
  objs.sort((x, y) => x.start - y.start);
  const parts: Uint8Array[] = [];
  let cur = 0;
  for (const o of objs) {
    const need = (8 - (cur % 8)) % 8;
    if (need > 0) {
      parts.push(new Uint8Array(need));
      cur += need;
    }
    o.newStart = cur;
    const bytes = o === tar ? newObj2 : slice(a, o.start + dataOff, o.size);
    parts.push(bytes);
    cur += bytes.length;
    o.newSize = bytes.length;
  }
  // 尾部：原数据区剩余（oldEnd 用旧偏移算）
  let oldEnd = 0;
  for (const o of objs) oldEnd = Math.max(oldEnd, o.start + o.size);
  parts.push(slice(a, dataOff + oldEnd, a.length - dataOff - oldEnd));

  const head = slice(a, 0, dataOff);
  for (const o of objs) {
    if (ver >= 22) put64(head, o.startOffset, o.newStart!, le);
    else put32(head, o.startOffset, o.newStart!, le);
    put32(head, o.sizeOffset, o.newSize!, le);
  }
  const out = concat(head, ...parts);
  if (ver >= 22) putBe64(out, 24, out.length);
  else putBe32(out, 4, out.length);
  return out;
}

// ---------- 重建 Bundle ----------

function crcFix(data: Uint8Array, target: number): Uint8Array {
  const base = new Uint8Array(data.length + 4);
  base.set(data, 0);
  const zero = crc32(base);
  const delta = (target ^ zero) | 0;
  const row = new Int32Array(32);
  const rhs = new Int32Array(32);
  for (let c = 0; c < 32; c++) {
    const q = base.slice();
    q[data.length + Math.floor(c / 8)] |= 1 << (c % 8);
    const effect = crc32(q) ^ zero;
    for (let r = 0; r < 32; r++) if (((effect >>> r) & 1) !== 0) row[r] |= 1 << c;
  }
  for (let r = 0; r < 32; r++) rhs[r] = (delta >>> r) & 1;
  // 高斯消元
  for (let c = 0; c < 32; c++) {
    let pivot = c;
    while (pivot < 32 && ((row[pivot] >>> c) & 1) === 0) pivot++;
    if (pivot === 32) throw new Error('CRC 修复矩阵无解');
    [row[c], row[pivot]] = [row[pivot], row[c]];
    [rhs[c], rhs[pivot]] = [rhs[pivot], rhs[c]];
    for (let r = 0; r < 32; r++) {
      if (r !== c && ((row[r] >>> c) & 1) !== 0) {
        row[r] ^= row[c];
        rhs[r] ^= rhs[c];
      }
    }
  }
  for (let b = 0; b < 32; b++) {
    if (rhs[b] !== 0) base[data.length + Math.floor(b / 8)] |= 1 << (b % 8);
  }
  // Java 端 `crc(base) == target` 是 32 位有符号 int 比较，JS 侧统一 |0
  if ((crc32(base) | 0) !== (target | 0)) throw new Error('CRC 修复校验失败');
  return base;
}

/** 重建 bundle：可选 crcFix + UnityFS（或按原 kh 签名回包）。 */
function build(b: KfbBundle, target: number | null, unityFs: boolean): Uint8Array {
  let logical = b.data;
  if (target != null) logical = crcFix(logical, target);

  const ip: Uint8Array[] = [new Uint8Array(16), be4(1), be4(logical.length), be4(logical.length), be2(0), be4(b.dirs.length)];
  for (const d of b.dirs) {
    ip.push(be8(d.off));
    ip.push(be8(d.size));
    ip.push(be4(d.flags));
    ip.push(concat(new TextEncoder().encode(d.name), new Uint8Array(1)));
  }
  const info = concat(...ip);
  // Java: `flags = b.flags & (-64) & (-129)` —— 清低 6 位(压缩类型) + bit7(尾随 BlockInfo)，
  // 输出不压缩的 UnityFS。注意 JS 位运算 ~64 清 bit6 是错的（会保留低 6 位压缩标记 3）。
  const flags = b.flags & ~0x3f & ~0x80;
  const h: Uint8Array[] = [
    new TextEncoder().encode('UnityFS'),
    new Uint8Array(1),
    be4(b.version),
    new TextEncoder().encode(b.unity),
    new Uint8Array(1),
    new TextEncoder().encode(b.revision),
    new Uint8Array(1),
    new Uint8Array(8),
    be4(info.length),
    be4(info.length),
    be4(flags),
  ];
  let header = concat(...h);
  if (b.version >= 7 || (flags & 512) !== 0) header = pad(header, 16);
  const standard = concat(
    (flags & 512) !== 0 ? concat(header, info, padLen(header.length + info.length, 16)) : concat(header, info),
    logical,
  );
  const sizePos = new TextEncoder().encode(b.unity).length + 12 + 1 + new TextEncoder().encode(b.revision).length + 1;
  putBe64(standard, sizePos, standard.length);
  return unityFs || b.kh < 0 ? standard : wrapKh(standard, b.signature, b.kh);
}

function wrapKh(standard: Uint8Array, original: string, ver: number): Uint8Array {
  const se = z(standard, 0);
  const p = z(standard, z(standard, se + 1 + 4) + 1) + 1 + 8;
  const size = be32(standard, p);
  let p2 = p + 12;
  if (be32(standard, p + 8) >>> 0 !== 0 && (standard[p + 8] & 128) !== 0) {
    throw new Error('不支持末尾 BlockInfo');
  }
  const fmt = be32(standard, se + 1);
  if (fmt >= 7 || (be32(standard, p + 8) & 512) !== 0) p2 = align16(p2);
  const enc = khCrypt(slice(standard, p2, size), size, ver, true);
  const body = slice(standard, se, p + 12 - se);
  const padN = Math.max(0, p2 - original.length - body.length);
  return concat(new TextEncoder().encode(original), body, new Uint8Array(padN), enc, slice(standard, p2 + size, standard.length - p2 - size));
}

function replaceDir(b: KfbBundle, d: KfbDir, replacement: Uint8Array): void {
  const old = d.size;
  const at = d.off;
  const delta = replacement.length - old;
  const n = new Uint8Array(b.data.length + delta);
  n.set(b.data.subarray(0, at), 0);
  n.set(replacement, at);
  n.set(b.data.subarray(at + old), at + replacement.length);
  b.data = n;
  d.size = replacement.length;
  for (const x of b.dirs) {
    if (x !== d && x.off > d.off) x.off += delta;
  }
}

// ---------- 顶层 API ----------

/** 解密 AssetBundle → 明文 .kfb。wanted 留空 = 自动找（多候选时报错列出名字）。 */
export async function decryptBundle(
  bytes: Uint8Array,
  keyText: string,
  wanted?: string,
): Promise<KfbExtracted> {
  const key = parseKey(keyText);
  const b = parse(bytes);
  const all = await find(b, wanted ?? null, key);
  if (all.length === 0) throw new Error('未找到可用的加密 TextAsset，请检查 AES Key 或 TextAsset 名称');
  if (all.length > 1 && (wanted == null || wanted.trim() === '')) {
    throw new Error(`找到多个加密 TextAsset：${all.map(x => x.name).join(', ')}。请填写 TextAsset 名称`);
  }
  const h = all[0];
  const plain = await decryptContainer(
    slice(b.data, h.dir.off + h.scriptOffset, h.scriptLen),
    key,
  );
  return { name: h.name, plain, candidates: all.length };
}

/** 仅扫描：返回所有可解密的候选 TextAsset 名（不抛多候选错误）。 */
export async function findCandidates(bytes: Uint8Array, keyText: string): Promise<string[]> {
  const key = parseKey(keyText);
  const b = parse(bytes);
  const all = await find(b, null, key);
  return all.map(x => x.name);
}

/** 回加密：明文 .kfb 写回原 bundle，输出新 .assetbundle。 */
export async function encryptBundle(
  originalBytes: Uint8Array,
  keyText: string,
  wanted: string,
  plain: Uint8Array,
  opts: KfbEncryptOptions = {},
): Promise<Uint8Array> {
  const key = parseKey(keyText);
  const b = parse(originalBytes);
  const origCrc = crc32(b.data); // Java 在 replaceDir 前用原文件算好默认 CRC
  const all = await find(b, wanted, key);
  if (all.length === 0) throw new Error('未找到可用的加密 TextAsset');
  if (all.length > 1) throw new Error(`找到多个加密 TextAsset：${all.map(x => x.name).join(', ')}。请填写名称`);
  const h = all[0];
  const encrypted = await encryptContainer(plain, key, h.outer, h.iv);
  const rebuilt = rebuildSerialized(slice(b.data, h.dir.off, h.dir.size), h, encrypted);
  replaceDir(b, h.dir, rebuilt);
  const target = opts.crcTarget ?? origCrc;
  return build(b, target, opts.unityFs ?? true);
}

// ---------- 仅导出类型不导出内部工具（调试时放开） ----------
export const __kfbInternals = {
  parseKey,
  khCrypt,
  lz4Decompress,
  lz4Store,
  crc32,
  parse,
  find,
  rebuildSerialized,
  build,
  crcFix,
  slice,
};

// ---------- 容器级 API（内联编辑用：TextAsset 对象已有容器字节，无需整包解析） ----------

/** 解析 AES key 文本（64 位十六进制 → 32 字节） */
export function parseKfbKey(keyText: string): Uint8Array {
  return parseKey(keyText);
}

/** 解密单个 KFB 容器（[4B 外层头][16B IV][AES-256-CTR 密文] → LZ4 → 明文） */
export async function decryptKfbContainer(
  container: Uint8Array,
  keyText: string,
): Promise<Uint8Array> {
  return decryptContainer(container, parseKey(keyText));
}

/**
 * 用内置 key 库自动匹配解密容器。
 * 遍历 key 列表逐个试解，命中（LZ4 解压成功）即返回明文与对应 key。
 */
export async function decryptKfbContainerAuto(
  container: Uint8Array,
  keyList: string[],
): Promise<{ plain: Uint8Array; key: string }> {
  let lastErr = '';
  for (const keyText of keyList) {
    try {
      const plain = await decryptContainer(container, parseKey(keyText));
      return { plain, key: keyText };
    } catch (e) {
      lastErr = `${e}`;
    }
  }
  throw new Error(`未找到匹配的 key（内置库 ${keyList.length} 个全试过）${lastErr ? '：' + lastErr.slice(0, 80) : ''}`);
}

/** 加密明文为 KFB 容器（复用原容器的外层头与 IV） */
export async function encryptKfbContainer(
  plain: Uint8Array,
  keyText: string,
  header: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  return encryptContainer(plain, parseKey(keyText), header, iv);
}
