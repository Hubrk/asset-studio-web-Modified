import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadAssetBundle as load } from '@arkntools/unity-js';
import { decryptKhBundle, isKhBundle } from '../khDecrypt';
import { encryptUnityFsToKh } from '../khEncrypt';

describe('Texture2D 端到端修改测试', () => {
  const testFile = 'C:\\Users\\34072\\Desktop\\纯立绘\\宇智波佐助[万花筒写轮眼]90059\\110943700.assetbundle';

  it('修改 Texture2D streamData → rebuild bundle → 重新解析验证', async () => {
    if (!existsSync(testFile)) { console.warn('skip: test file not found'); return; }

    const raw = readFileSync(testFile).buffer;
    let buffer: ArrayBuffer = raw;
    if (isKhBundle(buffer)) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);

    // 找到 Texture2D (AssetType.Texture2D = 28)
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex) { console.warn('skip: no Texture2D'); return; }

    // 验证是 streamData 模式
    if (!tex.streamData) { console.warn('skip: not streamData mode'); return; }

    // 记录原始纹理数据（image 是 private 属性，需要 as any 访问）
    const origRawData = new Uint8Array((tex as any).image.rawData);

    // 创建修改后的数据（将所有字节 +1，模拟修改）
    const modifiedData = new Uint8Array(origRawData.length);
    for (let i = 0; i < origRawData.length; i++) {
      modifiedData[i] = (origRawData[i] + 1) & 0xFF;
    }

    // 在 bundle.files 中找到对应 node
    // streamData.path 格式类似 'archive:/xxxx'，取最后一段匹配 node.path
    const sPath = tex.streamData.path.split('/').pop()!;
    const nodeIndex = bundle.nodes.findIndex(n => n.path === sPath);
    expect(nodeIndex).toBeGreaterThanOrEqual(0);

    // 在 node 数据中替换（in-place 修改 ArrayBuffer）
    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    const offset = tex.streamData.offset;
    const size = tex.streamData.size;
    expect(size).toBe(origRawData.length);

    // in-place 替换（大小不变）
    nodeData.set(modifiedData, offset);

    // rebuild bundle
    const rebuilt = bundle.rebuild();

    // 重新解析
    const bundle2 = await load(rebuilt);
    const tex2 = bundle2.objects.find(o => o.pathId === tex.pathId);
    expect(tex2).toBeDefined();

    // 验证修改后的数据
    const modifiedRawData = new Uint8Array((tex2 as any).image.rawData);
    expect(modifiedRawData.length).toBe(origRawData.length);
    for (let i = 0; i < origRawData.length; i++) {
      expect(modifiedRawData[i]).toBe((origRawData[i] + 1) & 0xFF);
    }
  }, 60000);

  it('修改 → rebuild → 加密为 KH → 解密 → 验证', async () => {
    if (!existsSync(testFile)) { console.warn('skip: test file not found'); return; }

    const raw = readFileSync(testFile).buffer;
    const isKh = isKhBundle(raw);
    let buffer: ArrayBuffer = raw;
    if (isKh) buffer = decryptKhBundle(buffer);

    const bundle = await load(buffer);
    const tex = bundle.objects.find(o => o.type === 28);
    if (!tex?.streamData) { console.warn('skip: no Texture2D with streamData'); return; }

    // 修改纹理数据（大小不变，只改第一个字节）
    const sPath = tex.streamData.path.split('/').pop()!;
    const nodeIndex = bundle.nodes.findIndex(n => n.path === sPath);
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    const nodeData = new Uint8Array(bundle.files[nodeIndex]);
    const origByte = nodeData[tex.streamData.offset];
    nodeData[tex.streamData.offset] = (origByte + 1) & 0xFF;

    // rebuild
    const rebuilt = bundle.rebuild();

    // 加密为 KH（fresh 路径，无需 meta）
    const encrypted = encryptUnityFsToKh(rebuilt, undefined, 'UnityKHFS');
    expect(isKhBundle(encrypted)).toBe(true);

    // 解密回来
    const decrypted = decryptKhBundle(encrypted);
    const bundle3 = await load(decrypted);
    const tex3 = bundle3.objects.find(o => o.pathId === tex.pathId);
    expect(tex3).toBeDefined();

    // 验证修改保持
    const finalData = new Uint8Array((tex3 as any).image.rawData);
    expect(finalData[0]).toBe((origByte + 1) & 0xFF);
  }, 60000);
});
