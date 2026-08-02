import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('Asset rebuild round-trip', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('rebuild produces identical bytes for unmodified asset', async () => {
    if (!existsSync(testFile)) {
      console.warn('skip: test file not found');
      return;
    }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) {
      buffer = decryptKhBundle(buffer);
    }

    const bundle = await loadAssetBundle(buffer);

    // Get the first object's asset (the SerializedFile that contains it)
    const obj = bundle.objects[0];
    if (!obj) {
      console.warn('skip: no objects');
      return;
    }
    const asset = (obj as any).__info.asset;

    // Get the original SerializedFile bytes
    const origData = asset.reader.rawBuffer.slice(0);

    // rebuild
    const rebuilt = asset.rebuild();

    // Verify rebuilt bytes match the original
    const origView = new Uint8Array(origData);
    const rebView = new Uint8Array(rebuilt);
    expect(rebView.length).toBe(origView.length);
    let mismatches = 0;
    for (let i = 0; i < origView.length; i++) {
      if (rebView[i] !== origView[i]) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`Mismatch at offset ${i}: expected ${origView[i]}, got ${rebView[i]}`);
        }
      }
    }
    expect(mismatches).toBe(0);
  }, 30000);
});
