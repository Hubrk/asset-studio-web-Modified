import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KH_FORMATS,
  KH_KEYS,
  decryptKhBundle,
  isKhBundle,
  isUnityFs,
  rotateBytes,
  splitKhBundle,
  xorDecrypt,
  type KhBundleMeta,
} from '../khDecrypt';
import {
  encryptKhBundle,
  encryptUnityFsToKh,
  encryptUnityFsToKhFresh,
} from '../khEncrypt';

// ============================================================================
// Test helpers
// ============================================================================

function invRotate(amount: number, n: number): number {
  const o = amount % n;
  return o === 0 ? 0 : n - o;
}

/**
 * Replicate the encrypt logic so we can build mock KH bundles from scratch.
 */
function encryptPayload(data: Uint8Array, c: number, fmt: number): Uint8Array {
  let l = new Uint8Array(data);
  const dBuf = new Uint8Array(8);
  new DataView(dBuf.buffer).setBigUint64(0, BigInt(c), false);

  if (fmt === 0) {
    l = xorDecrypt(l, KH_KEYS[0]);
  } else if (fmt === 1) {
    l = xorDecrypt(l, dBuf);
    l = xorDecrypt(l, KH_KEYS[1]);
  } else {
    const len = l.length;
    const eRot = ((len % 7) + 7) % len;
    const tKey = Number(c % 3 === 0 || c % 5 === 0 || c % 7 === 0);
    if (eRot === 0) {
      l = xorDecrypt(l, dBuf);
      l = xorDecrypt(l, KH_KEYS[tKey]);
    } else {
      const rRot = ((len % 7) + 1) % eRot;
      l = rotateBytes(l, 0, len, invRotate(rRot, len));
      for (let tI = 0; tI < len; tI += eRot) {
        const segLen = Math.min(eRot, len - tI);
        l = rotateBytes(l, tI, segLen, invRotate(rRot, segLen));
      }
      l = xorDecrypt(l, dBuf);
      l = xorDecrypt(l, KH_KEYS[tKey]);
      l = rotateBytes(l, 0, len, invRotate(eRot, len));
    }
  }
  return l;
}

/**
 * Build a mock KH bundle: magic(null-term) + o(31) + s(12) + flags(11/12) + encrypted_data(c) + tail
 */
function buildMockKhBundle(
  signature: string,
  dataLen: number,
  options?: { tailLen?: number },
): ArrayBuffer {
  const fmt = KH_FORMATS[signature];
  if (fmt === undefined) throw new Error(`Unknown signature: ${signature}`);

  const plaintext = crypto.getRandomValues(new Uint8Array(dataLen));
  const encrypted = encryptPayload(plaintext, dataLen, fmt);

  const magic = new TextEncoder().encode(signature);
  const o = crypto.getRandomValues(new Uint8Array(31));
  o[0] = 0; // null terminator

  const s = new Uint8Array(12);
  new DataView(s.buffer).setUint32(0, dataLen, false); // s[0:4] = c

  const flagsLen = fmt === 0 ? 12 : 11;
  const flags = crypto.getRandomValues(new Uint8Array(flagsLen));

  const tailLen = options?.tailLen ?? 8;
  const tail = crypto.getRandomValues(new Uint8Array(tailLen));

  // Set o[23:31] = KH file size (BE u64), matching what encryptKhBundle expects.
  const khSize = BigInt(magic.length + 31 + 12 + flagsLen + encrypted.length + tail.length);
  new DataView(o.buffer, o.byteOffset + 23, 8).setBigUint64(0, khSize, false);

  const total = magic.length + o.length + s.length + flags.length + encrypted.length + tail.length;
  const result = new Uint8Array(total);
  let off = 0;
  result.set(magic, off); off += magic.length;
  result.set(o, off); off += o.length;
  result.set(s, off); off += s.length;
  result.set(flags, off); off += flags.length;
  result.set(encrypted, off); off += encrypted.length;
  result.set(tail, off);
  return result.buffer;
}

function buildRandomUnityFs(dataLen: number): ArrayBuffer {
  // Real UnityFS: "UnityFS" + \0 + format(4) + version\0 + revision\0 + size(8) + data
  // The \0 at byte 7 is critical — it becomes o[0] in the KH header, used as null terminator
  const header = new TextEncoder().encode('UnityFS\0');
  const body = crypto.getRandomValues(new Uint8Array(dataLen));
  const result = new Uint8Array(header.length + body.length);
  result.set(header, 0);
  result.set(body, header.length);
  // Set the "size" field (bytes 30-37 = o[23:31] in KH layout) to the total file size.
  // encryptKhBundle reads this as unityFsSize and computes khSize = unityFsSize + magicDiff.
  // Without a valid size, the defense override produces a wrong khSize, breaking round-trip.
  const totalSize = BigInt(result.length);
  if (30 + 8 <= result.length) {
    new DataView(result.buffer, result.byteOffset + 30, 8).setBigUint64(0, totalSize, false);
  }
  return result.buffer;
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

// ============================================================================
// Basic algorithm tests
// ============================================================================
describe('xorDecrypt and rotateBytes', () => {
  it('xorDecrypt: symmetric property', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const key = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const encrypted = xorDecrypt(data, key);
    const decrypted = xorDecrypt(encrypted, key);
    expect(buffersEqual(decrypted.buffer, data.buffer)).toBe(true);
  });

  it('rotateBytes: rotating by n then (n-len) restores original', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const original = new Uint8Array(data);
    rotateBytes(data, 0, 8, 3);
    rotateBytes(data, 0, 8, 5);
    expect(buffersEqual(data.buffer, original.buffer)).toBe(true);
  });

  it('xorDecrypt: known vector', () => {
    const data = new Uint8Array([0x00, 0xFF, 0x55, 0xAA]);
    const key = new Uint8Array([0x12, 0x34]);
    const expected = new Uint8Array([0x12, 0xCB, 0x47, 0x9E]);
    const result = xorDecrypt(data, key);
    expect(buffersEqual(result.buffer, expected.buffer)).toBe(true);
  });
});

// ============================================================================
// Detection tests
// ============================================================================
describe('isKhBundle and isUnityFs detection', () => {
  it('detects UnityKHFS header', () => {
    const header = new TextEncoder().encode('UnityKHFS');
    const data = new Uint8Array(header.length + 1);
    data.set(header, 0);
    data[header.length] = 0;
    expect(isKhBundle(data.buffer)).toBe(true);
  });

  it('detects UnityKHNFS header', () => {
    const header = new TextEncoder().encode('UnityKHNFS');
    const data = new Uint8Array(header.length + 1);
    data.set(header, 0);
    data[header.length] = 0;
    expect(isKhBundle(data.buffer)).toBe(true);
  });

  it('detects UnityKH1FS header', () => {
    const header = new TextEncoder().encode('UnityKH1FS');
    const data = new Uint8Array(header.length + 1);
    data.set(header, 0);
    data[header.length] = 0;
    expect(isKhBundle(data.buffer)).toBe(true);
  });

  it('rejects invalid header', () => {
    const data = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
    expect(isKhBundle(data.buffer)).toBe(false);
  });

  it('isUnityFs detects UnityFS', () => {
    const data = new TextEncoder().encode('UnityFS\x00\x00\x00\x00\x00');
    expect(isUnityFs(data.buffer)).toBe(true);
  });

  it('isUnityFs rejects non-UnityFS', () => {
    const data = new TextEncoder().encode('NotUnity');
    expect(isUnityFs(data.buffer)).toBe(false);
  });
});

// ============================================================================
// Round-trip: decrypt → encrypt = original (all three formats)
// ============================================================================
describe('Round-trip: decrypt → encrypt = original', () => {
  const FORMATS = ['UnityKHFS', 'UnityKHNFS', 'UnityKH1FS'] as const;

  for (const sig of FORMATS) {
    it(`roundtrip ${sig} byte-exact (dataLen=100)`, () => {
      const original = buildMockKhBundle(sig, 100);
      const meta = splitKhBundle(original);
      const decrypted = decryptKhBundle(original);
      const reEncrypted = encryptKhBundle(decrypted, meta);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });

    it(`roundtrip ${sig} byte-exact (dataLen=256)`, () => {
      const original = buildMockKhBundle(sig, 256);
      const meta = splitKhBundle(original);
      const decrypted = decryptKhBundle(original);
      const reEncrypted = encryptKhBundle(decrypted, meta);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });

    it(`roundtrip ${sig} byte-exact (dataLen=1024)`, () => {
      const original = buildMockKhBundle(sig, 1024);
      const meta = splitKhBundle(original);
      const decrypted = decryptKhBundle(original);
      const reEncrypted = encryptKhBundle(decrypted, meta);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });

    it(`roundtrip ${sig} with tail (dataLen=88, tail=2000)`, () => {
      const original = buildMockKhBundle(sig, 88, { tailLen: 2000 });
      const meta = splitKhBundle(original);
      const decrypted = decryptKhBundle(original);
      const reEncrypted = encryptKhBundle(decrypted, meta);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });
  }
});

// ============================================================================
// eRot=0 edge case (KH1FS)
// ============================================================================
describe('eRot=0 edge case (KH1FS)', () => {
  it('roundtrip with dataLen=7 (eRot=0)', () => {
    const original = buildMockKhBundle('UnityKH1FS', 7);
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);
    const reEncrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(reEncrypted, original)).toBe(true);
  });

  it('roundtrip with dataLen=13 (eRot=0)', () => {
    const original = buildMockKhBundle('UnityKH1FS', 13);
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);
    const reEncrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(reEncrypted, original)).toBe(true);
  });
});

// ============================================================================
// Empty tail
// ============================================================================
describe('Empty tail', () => {
  it('roundtrip with tailLen=0', () => {
    const original = buildMockKhBundle('UnityKHFS', 100, { tailLen: 0 });
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);
    const reEncrypted = encryptKhBundle(decrypted, meta);
    expect(buffersEqual(reEncrypted, original)).toBe(true);
  });
});

// ============================================================================
// Fresh encryption (UnityFS → KH → UnityFS)
// ============================================================================
describe('Fresh encryption → decrypt', () => {
  const FORMATS = ['UnityKHFS', 'UnityKHNFS', 'UnityKH1FS'] as const;

  for (const sig of FORMATS) {
    it(`fresh ${sig} encrypt → decrypt produces valid UnityFS with matching o/s`, () => {
      const unityFs = buildRandomUnityFs(200);
      const encrypted = encryptUnityFsToKhFresh(unityFs, sig);
      expect(isKhBundle(encrypted)).toBe(true);

      // Decrypt back
      const decrypted = decryptKhBundle(encrypted);
      expect(isUnityFs(decrypted)).toBe(true);

      // Fresh encryption cannot be byte-identical because:
      //   - s[0:4] (bytes 38-41) is overwritten with the new encrypted-block length
      //   - bytes 50-63 are replaced with 14 zero-padding bytes
      // But the meaningful data must be preserved:
      const origView = new Uint8Array(unityFs);
      const decView = new Uint8Array(decrypted);

      // o block (bytes 7-37) matches
      for (let i = 7; i < 38; i++) {
        expect(decView[i]).toBe(origView[i]);
      }
      // s[0:4] (bytes 38-41) is updated to new c value — skip
      // s[4:12] (bytes 42-49) matches
      for (let i = 42; i < 50; i++) {
        expect(decView[i]).toBe(origView[i]);
      }
      // bytes 50-63 are 14 zero-padding — skip
      // Data after offset 64 should match
      for (let i = 64; i < origView.length; i++) {
        expect(decView[i]).toBe(origView[i]);
      }
    });
  }

  it('fresh encrypt → decrypt round-trip on a pre-decrypted UnityFS preserves data', () => {
    // Start with a KH file, decrypt it, then fresh-encrypt and decrypt again
    const original = buildMockKhBundle('UnityKHFS', 100, { tailLen: 200 });
    const decrypted1 = decryptKhBundle(original); // This is a proper decrypted UnityFS

    // Fresh encrypt the decrypted UnityFS
    // alignUnityFsBlock 可能会添加 padding 和 trailing，所以 decrypted2 可能比 decrypted1 大
    const encrypted = encryptUnityFsToKhFresh(decrypted1, 'UnityKHNFS');
    expect(isKhBundle(encrypted)).toBe(true);

    // Decrypt again
    const decrypted2 = decryptKhBundle(encrypted);
    expect(isUnityFs(decrypted2)).toBe(true);

    // 比较前 64 + c 字节（header + blocksInfo），跳过可能变化的字段
    const v1 = new Uint8Array(decrypted1);
    const v2 = new Uint8Array(decrypted2);
    const c1 = new DataView(v1.buffer, v1.byteOffset + 38, 4).getUint32(0, false);
    const c2 = new DataView(v2.buffer, v2.byteOffset + 38, 4).getUint32(0, false);

    // c 值应相同（alignUnityFsBlock 不改变 blocksInfo 大小，只改 block entry 的 size）
    expect(c2).toBe(c1);

    // 比较 header + blocksInfo 区域（前 64+c 字节），跳过 s[0:4] 和 size 字段
    const headerLen = 64 + c1;
    for (let i = 0; i < headerLen; i++) {
      if (i >= 38 && i < 42) continue; // skip s[0:4] — c
      if (i >= 30 && i < 38) continue; // skip size field in o block
      // blocksInfo 中的 block entry size 字段可能被 alignUnityFsBlock 修改
      // block entry 在 offset 64+16+4 = 84，size 字段在 84-91
      // 如果 alignUnityFsBlock 没有修改（mock 数据通常会被跳过），这里会通过
      // 如果修改了，这里会失败，但这是预期行为
      if (i >= 84 && i < 92) continue; // skip block entry uncSize + compSize
      expect(v2[i]).toBe(v1[i]);
    }

    // v2 长度应 >= v1（可能添加了 padding + trailing）
    expect(v2.length).toBeGreaterThanOrEqual(v1.length);
  });
});

// ============================================================================
// encryptUnityFsToKh dispatch
// ============================================================================
describe('encryptUnityFsToKh dispatch', () => {
  it('with meta → uses roundtrip path', () => {
    const mock = buildMockKhBundle('UnityKHFS', 100);
    const meta = splitKhBundle(mock);
    const decrypted = decryptKhBundle(mock);
    const encrypted = encryptUnityFsToKh(decrypted, meta);
    expect(buffersEqual(encrypted, mock)).toBe(true);
  });

  it('without meta → uses fresh path', () => {
    const unityFs = buildRandomUnityFs(100);
    const encrypted = encryptUnityFsToKh(unityFs);
    expect(isKhBundle(encrypted)).toBe(true);
  });

  it('without meta with signature → fresh path with specified format', () => {
    const unityFs = buildRandomUnityFs(100);
    const encrypted = encryptUnityFsToKh(unityFs, undefined, 'UnityKHNFS');
    expect(isKhBundle(encrypted)).toBe(true);
    // Verify signature
    const t = new Uint8Array(encrypted);
    let n = -1;
    for (let i = 0; i < 12; i++) { if (t[i] === 0) { n = i; break; } }
    const sig = String.fromCharCode(...t.slice(0, n));
    expect(sig).toBe('UnityKHNFS');
  });
});

// ============================================================================
// Real game file roundtrip
// ============================================================================
describe('Real game file roundtrip', () => {
  const BASE = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059';
  const FILES = [
    `${BASE}\\110943700.assetbundle`,
    `${BASE}\\4087659059.assetbundle`,
  ];

  for (const filePath of FILES) {
    const fileName = filePath.split('\\').pop()!;
    it(`roundtrip ${fileName}`, () => {
      if (!existsSync(filePath)) {
        console.warn(`Skipping: file not found: ${filePath}`);
        return;
      }
      const original = readFileSync(filePath).buffer;
      expect(isKhBundle(original)).toBe(true);

      const meta = splitKhBundle(original);
      const decrypted = decryptKhBundle(original);
      expect(isUnityFs(decrypted)).toBe(true);

      const reEncrypted = encryptKhBundle(decrypted, meta);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });
  }
});

// ============================================================================
// Modified data roundtrip
// ============================================================================
describe('Modified data roundtrip', () => {
  it('modified byte is preserved through roundtrip', () => {
    const original = buildMockKhBundle('UnityKHFS', 200);
    const meta = splitKhBundle(original);
    const decrypted = decryptKhBundle(original);

    const modified = new Uint8Array(decrypted.slice(0));
    const modPos = 100; // in the data region (after 64-byte header)
    modified[modPos] ^= 0xFF;

    const reEncrypted = encryptKhBundle(modified.buffer, meta);
    const reDecrypted = decryptKhBundle(reEncrypted);

    const reView = new Uint8Array(reDecrypted);
    expect(reView[modPos]).toBe(modified[modPos]);
  });
});
