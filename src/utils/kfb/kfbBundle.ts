/**
 * KFB 容器级加解密（浏览器移植版）。
 * 容器布局： [0:4] header(4B) + [4:16] IV(12B) + [16:20] counter块尾(4B) + [20:] 密文
 * AES-CTR 的 counter 块 = [4:20]（16 字节，12B nonce + 4B 块计数），这是 WebCrypto 唯一可行解释。
 *
 * 提供多候选容错解密（原版抖动的不同布局均可处理），保证与游戏字节级兼容。
 */

import { Buffer } from 'buffer';

/** LZ4 解压（块解压，n 为目标解压尺寸） */
export function lz4Decompress(x: Uint8Array, n: number): Uint8Array {
  if (n < 0 || n > 1073741824) throw new Error(`LZ4 解压尺寸无效: ${n}`);
  const o = new Uint8Array(n);
  let t = 0;
  let p = 0;
  while (t < x.length) {
    const token = x[t] & 255;
    let v = t + 1;
    let litLen = token >>> 4;
    if (litLen === 15) {
      for (;;) {
        if (v >= x.length) throw new Error('LZ4 截断');
        const b = x[v++] & 255;
        litLen += b;
        if (b !== 255) break;
      }
    }
    if (v + litLen > x.length || p + litLen > n) throw new Error('LZ4 字面量无效');
    o.set(x.subarray(v, v + litLen), p);
    v += litLen;
    p += litLen;
    if (v === x.length) break;
    if (v + 2 > x.length) throw new Error('LZ4 回溯截断');
    const off = (x[v] & 255) | ((x[v + 1] & 255) << 8);
    v += 2;
    let m = (token & 15) + 4;
    if ((token & 15) === 15) {
      for (;;) {
        if (v >= x.length) throw new Error('LZ4 截断');
        const b = x[v++] & 255;
        m += b;
        if (b !== 255) break;
      }
    }
    if (off === 0 || off > p || p + m > n) throw new Error('LZ4 数据块无效');
    for (let q = 0; q < m; q++) o[p] = o[p - off], p++;
    t = v;
  }
  if (p !== n) throw new Error('LZ4 长度不匹配');
  return o;
}

/** LZ4 字面量块存储（首 4 字节 LE 解压长度 + 5 字节 token 头 + 原文），与游戏解析格式一致 */
export function lz4Store(a: Uint8Array): Uint8Array {
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

async function aesCtrEncryptDecrypt(data: Uint8Array, keyBytes: Uint8Array, counter: Uint8Array, encrypt: boolean): Promise<Uint8Array> {
  const algo = { name: 'AES-CTR', counter: counter as unknown as ArrayBuffer, length: 128 };
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'AES-CTR' },
    false,
    encrypt ? ['encrypt'] : ['decrypt'],
  );
  const out = encrypt
    ? await crypto.subtle.encrypt(algo, key, data as unknown as BufferSource)
    : await crypto.subtle.decrypt(algo, key, data as unknown as BufferSource);
  return new Uint8Array(out);
}

/** 64 位十六进制 → 32 字节 AES-256 密钥 */
export function parseKfbKey(text: string): Uint8Array {
  const t = (text ?? '').trim();
  if (!/^[0-9a-f]{64}$/i.test(t)) throw new Error('AES-256 Key 必须是 64 位十六进制字符串');
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = parseInt(t.substring(i * 2, i * 2 + 2), 16);
  return r;
}

export interface KfbContainerMeta {
  /** 容器前 4 字节（保留原样写回） */
  header: Uint8Array;
  /** 16 字节 AES-CTR counter 块（= 容器 [4:20]） */
  counter: Uint8Array;
  /** 匹配成功的解密布局（加密回写时复用） */
  guess?: { iv: Uint8Array; cipherStart: number };
}

const ZEROS_4 = new Uint8Array(4);

/** 生成候选 (IV, cipherStart)：覆盖原版/回写版两种密文偏移与 counter 组装方式 */
function candidateLayouts(container: Uint8Array): { iv: Uint8Array; cipherStart: number }[] {
  const iv12 = container.slice(4, 16);
  const ivWithSuffix = Buffer.concat([Buffer.from(iv12), Buffer.from(ZEROS_4)]);
  const full16 = container.slice(4, 20);
  const out: { iv: Uint8Array; cipherStart: number }[] = [];
  for (const cipherStart of [20, 16]) {
    out.push({ iv: full16, cipherStart });
    out.push({ iv: ivWithSuffix, cipherStart });
  }
  return out;
}

/** 从容器提取写回所需元数据（header + 16 字节 counter） */
export function kfbContainerMeta(container: Uint8Array): KfbContainerMeta {
  return {
    header: container.slice(0, 4),
    counter: container.slice(4, 20),
  };
}

async function decryptContainerLayout(container: Uint8Array, key: Uint8Array, guess: { iv: Uint8Array; cipherStart: number }): Promise<Uint8Array> {
  const cipher = container.slice(guess.cipherStart, container.length);
  if (cipher.length === 0) throw new Error('KFB 密文为空');
  const plain = await aesCtrEncryptDecrypt(cipher, key, guess.iv, false);
  if (plain.length < 5) throw new Error('KFB 明文过短');
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const size = view.getUint32(0, true);
  return lz4Decompress(plain.slice(4, plain.length), size);
}

/**
 * 解密 KFB 容器（AES-CTR 解出 [4B LE 解压长度][LZ4 流]）。
 * 自动尝试多种布局，返回 { plain, guess }；guess 供加密回写复用同一套参数。
 */
export async function decryptKfbContainerEx(
  container: Uint8Array,
  keyText: string,
): Promise<{ plain: Uint8Array; guess: { iv: Uint8Array; cipherStart: number } }> {
  if (container.length <= 20) throw new Error('KFB 容器过短');
  const key = parseKfbKey(keyText);
  let lastErr = '';
  for (const guess of candidateLayouts(container)) {
    try {
      const plain = await decryptContainerLayout(container, key, guess);
      return { plain, guess };
    } catch (e) {
      lastErr = `${e}`;
    }
  }
  throw new Error(`KFB 解密失败${lastErr ? `（${lastErr.slice(0, 80)}）` : ''}`);
}

/** 解密 KFB 容器（自动匹配布局） */
export async function decryptKfbContainer(container: Uint8Array, keyText: string): Promise<Uint8Array> {
  const { plain } = await decryptKfbContainerEx(container, keyText);
  return plain;
}

/** 加密 KFB 明文为容器：[header][counter 16B][AES-CTR(LZ4Store(明文))]，与原版容器布局一致 */
export async function encryptKfbContainer(
  plain: Uint8Array,
  keyText: string,
  header: Uint8Array,
  counter: Uint8Array,
): Promise<Uint8Array> {
  if (counter.length !== 16) throw new Error('KFB counter 必须为 16 字节');
  const key = parseKfbKey(keyText);
  const cipher = await aesCtrEncryptDecrypt(lz4Store(plain), key, counter, true);
  const out = new Uint8Array(header.length + counter.length + cipher.length);
  out.set(header, 0);
  out.set(counter, header.length);
  out.set(cipher, header.length + counter.length);
  return out;
}

/** 自动匹配密钥：逐个尝试 keyList 中的密钥 */
export async function decryptKfbContainerAuto(
  container: Uint8Array,
  keyList: string[],
): Promise<{ plain: Uint8Array; key: string; guess: { iv: Uint8Array; cipherStart: number } }> {
  let lastErr = '';
  for (const keyText of keyList || []) {
    try {
      const { plain, guess } = await decryptKfbContainerEx(container, keyText);
      return { plain, key: keyText, guess };
    } catch (e) {
      lastErr = `${e}`;
    }
  }
  throw new Error(`未找到匹配的 key（共尝试 ${(keyList || []).length} 个）${lastErr ? `：${lastErr.slice(0, 80)}` : ''}`);
}

/** KFB 容器签名识别：首两字节为 00 0E 或 00 0F */
export function isKfbContainer(data: ArrayBuffer | Uint8Array | null | undefined): boolean {
  if (!data) return false;
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u.length < 2) return false;
  return u[0] === 0x00 && (u[1] === 0x0e || u[1] === 0x0f);
}