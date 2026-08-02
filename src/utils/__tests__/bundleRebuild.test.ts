import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAssetBundle } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';

describe('BundleFile rebuild round-trip', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('rebuild produces valid bundle that can be re-parsed', async () => {
    if (!existsSync(testFile)) {
      console.warn('skip: test file not found');
      return;
    }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await loadAssetBundle(buffer);
    const rebuilt = bundle.rebuild();

    // 验证重建后能重新解析
    const bundle2 = await loadAssetBundle(rebuilt);
    expect(bundle2.objects.length).toBe(bundle.objects.length);

    // 验证每个 object 的原始字节一致
    for (let i = 0; i < bundle.objects.length; i++) {
      const origRaw = bundle.objects[i].getRaw();
      const rebRaw = bundle2.objects[i].getRaw();
      const o = new Uint8Array(origRaw);
      const r = new Uint8Array(rebRaw);
      expect(r.length).toBe(o.length);
      let mismatches = 0;
      for (let j = 0; j < o.length; j++) {
        if (r[j] !== o[j]) {
          mismatches++;
          if (mismatches <= 3) {
            console.error(`Object ${i} mismatch at byte ${j}: expected ${o[j]}, got ${r[j]}`);
          }
        }
      }
      expect(mismatches).toBe(0);
    }
  }, 30000);

  it('rebuild after modifying texture data preserves changes', async () => {
    if (!existsSync(testFile)) {
      console.warn('skip: test file not found');
      return;
    }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await loadAssetBundle(buffer);

    // 找到 Texture2D (type 28)
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex?.streamData) {
      console.warn('skip: no streamData texture');
      return;
    }

    // 修改纹理数据（在 bundle.files 的对应 node 中）
    const nodeIndex = bundle.nodes.findIndex(
      n => n.path === tex.streamData!.path.split('/').pop(),
    );
    if (nodeIndex < 0) {
      console.warn('skip: node not found');
      return;
    }

    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    const origByte = nodeData[tex.streamData.offset];
    nodeData[tex.streamData.offset] = (origByte + 1) & 0xff;

    // rebuild
    const rebuilt = bundle.rebuild();

    // 重新解析
    const bundle2 = await loadAssetBundle(rebuilt);
    const tex2 = bundle2.objects.find(o => o.pathId === tex.pathId);
    expect(tex2).toBeDefined();
    if (!tex2?.streamData) {
      console.warn('skip: rebuilt texture has no streamData');
      return;
    }

    // 验证修改保持
    const nodeIndex2 = bundle2.nodes.findIndex(
      n => n.path === tex2.streamData!.path.split('/').pop(),
    );
    const nodeData2 = new Uint8Array(bundle2.files[nodeIndex2]);
    expect(nodeData2[tex2.streamData.offset]).toBe((origByte + 1) & 0xff);
  }, 30000);
});
