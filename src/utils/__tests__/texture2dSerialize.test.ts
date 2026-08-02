import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArrayBufferWriter, loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('Texture2D serialize round-trip', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('Texture2D serialize produces identical bytes (streamData mode)', async () => {
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
    // AssetType.Texture2D = 28
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex) {
      console.warn('skip: no Texture2D found');
      return;
    }

    // 获取原始字节
    const rawBytes = tex.getRaw();

    // serialize
    const writer = new ArrayBufferWriter(rawBytes.byteLength);
    (tex as any).serialize(writer);
    const serialized = writer.getBuffer();

    // 验证 serialize 产生的字节与原始字节一致
    const rawView = new Uint8Array(rawBytes);
    const serView = new Uint8Array(serialized);
    expect(serView.length).toBe(rawView.length);
    let mismatches = 0;
    for (let i = 0; i < rawView.length; i++) {
      if (serView[i] !== rawView[i]) {
        mismatches++;
        if (mismatches <= 5) {
          console.error(`Mismatch at offset ${i}: expected ${rawView[i]}, got ${serView[i]}`);
        }
      }
    }
    expect(mismatches).toBe(0);
  }, 30000);
});
