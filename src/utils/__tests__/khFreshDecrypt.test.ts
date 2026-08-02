import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decryptKhBundle, isKhBundle, isUnityFs, splitKhBundle } from '../khDecrypt';
import { encryptKhBundle, encryptUnityFsToKh, encryptUnityFsToKhFresh } from '../khEncrypt';

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
// Fresh encryption of a pre-decrypted UnityFS must reproduce the original KH
// file byte-for-byte (the "decrypted → re-import → fresh encrypt" scenario).
// ============================================================================
describe('Fresh encryption of decrypted UnityFS = original KH file', () => {
  const BASE = 'C:\\Users\\34072\\Desktop\\带土立绘\\改幼刀丛雨';
  const FILES = ['4123779853.assetbundle', '534150399.assetbundle'];

  for (const file of FILES) {
    const origPath = `${BASE}\\${file}`;
    const decPath = `${BASE}\\decrypted_2026-07-22_115536\\${file}`;

    it(`fresh encrypt of decrypted ${file} = original (byte-identical)`, () => {
      if (!existsSync(origPath) || !existsSync(decPath)) {
        console.warn('Skipping: file not found');
        return;
      }
      const original = readFileSync(origPath).buffer;
      const decrypted = readFileSync(decPath).buffer;

      // Sanity checks
      expect(isKhBundle(original)).toBe(true);
      expect(isUnityFs(decrypted)).toBe(true);

      // Fresh encrypt the decrypted UnityFS (no meta — simulates re-import)
      const freshEncrypted = encryptUnityFsToKhFresh(decrypted, 'UnityKHFS');

      // Must be byte-identical to the original KH file
      expect(buffersEqual(freshEncrypted, original)).toBe(true);
    });

    it(`encryptUnityFsToKh (no meta) of decrypted ${file} = original`, () => {
      if (!existsSync(origPath) || !existsSync(decPath)) {
        console.warn('Skipping: file not found');
        return;
      }
      const original = readFileSync(origPath).buffer;
      const decrypted = readFileSync(decPath).buffer;

      const reEncrypted = encryptUnityFsToKh(decrypted);
      expect(buffersEqual(reEncrypted, original)).toBe(true);
    });
  }
});
