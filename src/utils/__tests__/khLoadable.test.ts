import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { splitKhBundle, decryptKhBundle, isUnityFs } from '../khDecrypt';
import { loadAssetBundle } from '@arkntools/unity-js';

// ============================================================================
// Loadability regression guard
// ----------------------------------------------------------------------------
// decryptKhBundle must produce a *fully valid* UnityFS that @arkntools/unity-js
// can parse — i.e. it must NOT truncate the blockData region. A previous
// attempt to re-derive the KH header padding inside decryptKhBundle broke
// loadAssetBundle with "End position out of boundary"; that change was
// reverted. This test pins the contract so it can never regress silently.
// Runs against committed fixtures only — CI-portable, no desktop paths.
// ============================================================================

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'kh');

function khFixtures(): { name: string; ab: ArrayBuffer }[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.assetbundle'))
    .map((name) => {
      const buf = readFileSync(join(FIXTURE_DIR, name));
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      try {
        splitKhBundle(ab);
      } catch {
        return null;
      }
      const sig = new TextDecoder().decode(
        (splitKhBundle(ab).header as Uint8Array).subarray(0, 7),
      );
      if (!sig.startsWith('UnityKH')) return null;
      return { name, ab };
    })
    .filter((x): x is { name: string; ab: ArrayBuffer } => x !== null);
}

describe('解密后的 KH 包必须能被 loadAssetBundle 加载', () => {
  const fixtures = khFixtures();

  it('fixture 目录至少包含一个可测 KH 包', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    it(`${f.name} 解密后能被 loadAssetBundle 加载`, async () => {
      const decrypted = decryptKhBundle(f.ab);

      // 解密产物必须是合法 UnityFS
      expect(isUnityFs(decrypted)).toBe(true);

      // 必须能被 @arkntools/unity-js 正常加载，且不得抛出
      // "End position out of boundary"（blockData 被截断的标志）
      const bundle = await loadAssetBundle(decrypted);
      expect(bundle).toBeDefined();
    });
  }
});
