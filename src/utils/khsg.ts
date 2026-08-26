/**
 * KHSG container — decrypt / encrypt engine for com.tencent.KiHan config files.
 *
 * CONFIRMED SCHEME (reverse-engineered from libil2cpp.so v1.78.78.8):
 *   - Key (16 bytes, fixed per version) =
 *       Rfc2898DeriveBytes(crypticCode:string, salt:byte[], iterations:int)
 *       -> standard PBKDF2-HMACSHA1 (see deriveKeyPbkdf2 / deriveIvPbkdf2).
 *   - IV (16 bytes, per-file) = GenIV(code) using the same KDF family on the
 *       per-file "code" embedded in the header (see deriveIvPbkdf2).
 *   - Mode/padding: .NET Aes.Create() default = AES-128-CBC + PKCS7.
 *   - Layout: [4 magic "KHSG"] [9-byte structured header incl. the per-file code]
 *             [AES-128-CBC ciphertext, PKCS7]  -> HEADER_SIZE = 13.
 *
 * The real crypticCode/salt/iterations live in the encrypted global-metadata.dat
 * (not recoverable statically). Supply the derived Key/IV directly, or run the
 * PBKDF2 derivation once you have the metadata constants (or a Frida dump).
 *
 * Reuses xorDecrypt / rotateBytes from khDecrypt.ts for the UnityKH-family
 * "xor-rotate" path; AES uses the browser Web Crypto API (CTR / CBC / ECB).
 */

import { xorDecrypt, rotateBytes } from './khDecrypt';

export const KHSG_MAGIC = 'KHSG';
export const KHSG_HEADER_SIZE = 13;

export type KhsgAlgo = 'aes-ctr' | 'aes-cbc' | 'aes-ecb' | 'xor-rotate';

export interface KhsgConfig {
  /** cipher family */
  algo: KhsgAlgo;
  /** AES key, 16/24/32 bytes (unused for xor-rotate) */
  key?: Uint8Array;
  /** AES IV/nonce, 16 bytes (unused for ecb) */
  iv?: Uint8Array;
  /** number of header bytes before the ciphertext (KHSG = 13) */
  headerSize?: number;
  /** xor-rotate format selector 0/1/2 */
  fmt?: number;
  /** xor-rotate keys [key0, key1] */
  keys?: [Uint8Array, Uint8Array];
  // metadata-derived inputs (used to derive key/iv if not supplied directly)
  crypticCode?: string;
  salt?: Uint8Array;
  iterations?: number;
  /** per-file IV "code" (string or bytes) */
  code?: string | Uint8Array;
  ivSalt?: Uint8Array;
  ivIterations?: number;
}

const DEFAULT_KEYS: [Uint8Array, Uint8Array] = [
  new TextEncoder().encode('X@85Pq!6v$lCt7UYsihH3!cPb1P71bo4lX59FXqY!VO$YiYsu!Keu3aVZwi5on5l'),
  new TextEncoder().encode('hAi5luE8FlyblDdCTQC9uxnj3rkNwd1swrKI7Mx1aDFEe2B5h#3X&s54%GuSeHf@'),
];

// ---------- PBKDF2 (mirrors .NET Rfc2898DeriveBytes / GenIV) ----------
/** Key = PBKDF2-HMACSHA1(password=crypticCode, salt, iterations, length). */
export async function deriveKeyPbkdf2(
  crypticCode: string | Uint8Array,
  salt: string | Uint8Array,
  iterations: number,
  length = 16,
): Promise<Uint8Array> {
  return pbkdf2Sha1(crypticCode, salt, iterations, length);
}

/** IV = PBKDF2-HMACSHA1(code, salt-or-code, iterations, length). */
export async function deriveIvPbkdf2(
  code: string | Uint8Array,
  salt?: string | Uint8Array,
  iterations = 1,
  length = 16,
): Promise<Uint8Array> {
  return pbkdf2Sha1(code, salt ?? code, iterations, length);
}

async function pbkdf2Sha1(
  password: string | Uint8Array,
  salt: string | Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const pw = typeof password === 'string' ? new TextEncoder().encode(password) : password;
  const slt = typeof salt === 'string' ? new TextEncoder().encode(salt) : salt;
  const baseKey = await crypto.subtle.importKey('raw', toAB(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: toAB(slt), iterations, hash: 'SHA-1' },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Resolve key/iv from metadata-derived inputs when supplied. */
async function resolveCfg(cfg: KhsgConfig): Promise<KhsgConfig> {
  if (!cfg.key && cfg.crypticCode && cfg.salt && cfg.iterations != null) {
    cfg = { ...cfg, key: await deriveKeyPbkdf2(cfg.crypticCode, cfg.salt, cfg.iterations, 16) };
  }
  if (!cfg.iv && cfg.code) {
    cfg = { ...cfg, iv: await deriveIvPbkdf2(cfg.code, cfg.ivSalt, cfg.ivIterations ?? 1, 16) };
  }
  return cfg;
}

function pkcs7Unpad(b: Uint8Array): Uint8Array {
  if (b.length === 0) return b;
  const p = b[b.length - 1];
  if (p >= 1 && p <= 16 && b.slice(b.length - p).every(x => x === p)) {
    return b.slice(0, b.length - p);
  }
  return b;
}

// TS 5.7+ types Uint8Array as Uint8Array<ArrayBufferLike>, but Web Crypto
// requires ArrayBuffer-backed views. Coerce safely (no-op at runtime).
function toAB(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u.length);
  out.set(u);
  return out;
}

// ---------- UnityKH-family xor+rotate (ported from khDecrypt.ts decrypt) ----------
function xorRotateDecrypt(payload: Uint8Array, fmt: number, keys: [Uint8Array, Uint8Array]): Uint8Array {
  let l = payload;
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, BigInt(payload.length), false);
  if (fmt === 0) {
    l = xorDecrypt(l, keys[0]);
  } else if (fmt === 1) {
    l = xorDecrypt(l, keys[1]);
    l = xorDecrypt(l, d);
  } else {
    const eRot = ((l.length % 7) + 7) % l.length;
    l = rotateBytes(l, 0, l.length, eRot) as Uint8Array;
    const tKey = Number(payload.length % 3 === 0 || payload.length % 5 === 0 || payload.length % 7 === 0);
    l = xorDecrypt(l, keys[tKey]);
    l = xorDecrypt(l, d);
    if (eRot !== 0) {
      const rRot = ((l.length % 7) + 1) % eRot;
      for (let tI = 0; tI < l.length; tI += eRot) {
        l = rotateBytes(l, tI, eRot, rRot) as Uint8Array;
      }
      l = rotateBytes(l, 0, l.length, rRot) as Uint8Array;
    }
  }
  return l;
}

function xorRotateEncrypt(plain: Uint8Array, fmt: number, keys: [Uint8Array, Uint8Array]): Uint8Array {
  let l = plain;
  const d = new Uint8Array(8);
  new DataView(d.buffer).setBigUint64(0, BigInt(plain.length), false);
  if (fmt === 0) {
    l = xorDecrypt(l, keys[0]);
  } else if (fmt === 1) {
    l = xorDecrypt(l, d);
    l = xorDecrypt(l, keys[1]);
  } else {
    const eRot = ((l.length % 7) + 7) % l.length;
    const tKey = Number(plain.length % 3 === 0 || plain.length % 5 === 0 || plain.length % 7 === 0);
    if (eRot !== 0) {
      const rRot = ((l.length % 7) + 1) % eRot;
      l = rotateBytes(l, 0, l.length, ((l.length - rRot) % l.length + l.length) % l.length) as Uint8Array;
      for (let tI = 0; tI < l.length; tI += eRot) {
        const eff = Math.min(eRot, l.length - tI);
        const inv = ((eff - rRot) % eff + eff) % eff;
        l = rotateBytes(l, tI, eff, inv) as Uint8Array;
      }
      l = rotateBytes(l, 0, l.length, ((l.length - rRot) % l.length + l.length) % l.length) as Uint8Array;
    }
    l = xorDecrypt(l, d);
    l = xorDecrypt(l, keys[tKey]);
    l = rotateBytes(l, 0, l.length, ((l.length - eRot) % l.length + l.length) % l.length) as Uint8Array;
  }
  return l;
}

// ---------- AES via Web Crypto ----------
async function aesDecrypt(
  payload: Uint8Array,
  algo: 'aes-ctr' | 'aes-cbc' | 'aes-ecb',
  key: Uint8Array,
  iv?: Uint8Array,
): Promise<Uint8Array> {
  const algoName = algo === 'aes-ctr' ? 'AES-CTR' : algo === 'aes-cbc' ? 'AES-CBC' : 'AES-ECB';
  const cryptoKey = await crypto.subtle.importKey('raw', toAB(key), { name: algoName }, false, ['decrypt']);
  const buf = await crypto.subtle.decrypt(
    algo === 'aes-ecb' ? { name: 'AES-ECB' } : { name: algoName, iv: toAB(iv ?? new Uint8Array(16)) },
    cryptoKey,
    toAB(payload),
  );
  const out = new Uint8Array(buf);
  return algo === 'aes-ctr' ? out : pkcs7Unpad(out);
}

async function aesEncrypt(
  plain: Uint8Array,
  algo: 'aes-ctr' | 'aes-cbc' | 'aes-ecb',
  key: Uint8Array,
  iv?: Uint8Array,
): Promise<Uint8Array> {
  const algoName = algo === 'aes-ctr' ? 'AES-CTR' : algo === 'aes-cbc' ? 'AES-CBC' : 'AES-ECB';
  const cryptoKey = await crypto.subtle.importKey('raw', toAB(key), { name: algoName }, false, ['encrypt']);
  let data = plain;
  if (algo !== 'aes-ctr') {
    const pad = 16 - (plain.length % 16);
    const padded = new Uint8Array(plain.length + pad);
    padded.set(plain);
    padded.fill(pad, plain.length);
    data = padded;
  }
  const buf = await crypto.subtle.encrypt(
    algo === 'aes-ecb' ? { name: 'AES-ECB' } : { name: algoName, iv: toAB(iv ?? new Uint8Array(16)) },
    cryptoKey,
    toAB(data),
  );
  return new Uint8Array(buf);
}

// ---------- public API ----------
export function isKhsg(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  return new TextDecoder().decode(new Uint8Array(data, 0, 4)) === KHSG_MAGIC;
}

/** Return the structured header (bytes between magic and ciphertext). */
export function readOriginalHeader(data: ArrayBuffer, headerSize = KHSG_HEADER_SIZE): Uint8Array {
  const t = new Uint8Array(data);
  if (new TextDecoder().decode(t.slice(0, 4)) !== KHSG_MAGIC) {
    throw new Error('Not a KHSG file');
  }
  return t.slice(4, headerSize);
}

export async function decryptKhsg(data: ArrayBuffer, cfg: KhsgConfig): Promise<ArrayBuffer> {
  const resolved = await resolveCfg(cfg);
  const t = new Uint8Array(data);
  if (new TextDecoder().decode(t.slice(0, 4)) !== KHSG_MAGIC) {
    throw new Error('Not a KHSG file');
  }
  const headerSize = resolved.headerSize ?? KHSG_HEADER_SIZE;
  const payload = t.slice(headerSize);
  let out: Uint8Array;
  if (resolved.algo === 'xor-rotate') {
    out = xorRotateDecrypt(payload, resolved.fmt ?? 2, resolved.keys ?? DEFAULT_KEYS);
  } else {
    if (!resolved.key) throw new Error('AES key required (supply directly or via crypticCode/salt/iterations)');
    if (resolved.algo !== 'aes-ecb' && !resolved.iv) throw new Error('AES IV required (supply directly or via code)');
    out = await aesDecrypt(payload, resolved.algo, resolved.key, resolved.iv);
  }
  return out.buffer as ArrayBuffer;
}

/**
 * Re-encrypt plaintext back into a KHSG blob.
 * Pass the original structured header (readOriginalHeader) via `header` to keep
 * the exact same 13-byte prefix (and therefore the same per-file IV code).
 */
export async function encryptKhsg(
  plaintext: ArrayBuffer,
  cfg: KhsgConfig,
  header?: Uint8Array,
): Promise<ArrayBuffer> {
  const resolved = await resolveCfg(cfg);
  const plain = new Uint8Array(plaintext);
  let body: Uint8Array;
  if (resolved.algo === 'xor-rotate') {
    body = xorRotateEncrypt(plain, resolved.fmt ?? 2, resolved.keys ?? DEFAULT_KEYS);
  } else {
    if (!resolved.key) throw new Error('AES key required');
    if (resolved.algo !== 'aes-ecb' && !resolved.iv) throw new Error('AES IV required');
    body = await aesEncrypt(plain, resolved.algo, resolved.key, resolved.iv);
  }
  const headerSize = resolved.headerSize ?? KHSG_HEADER_SIZE;
  const extra = header ?? new Uint8Array(Math.max(0, headerSize - 4));
  const result = new Uint8Array(4 + extra.length + body.length);
  result.set(new TextEncoder().encode(KHSG_MAGIC), 0);
  result.set(extra, 4);
  result.set(body, 4 + extra.length);
  return result.buffer;
}
