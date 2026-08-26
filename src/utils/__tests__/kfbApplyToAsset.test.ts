import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAssetBundle } from '@arkntools/unity-js';
import {
  decryptBundle,
  encryptBundle,
} from '../../workers/assetManager/loaders/kfbBundle';
import {
  decodeKfb,
  encodeKfb,
} from '../../workers/assetManager/loaders/kfbCodec';

/**
 * 验证 kfbApplyToAsset 重写后的写回链路（回归 bug：改一处即抛
 * "RangeError: offset is out of bounds"，根因是旧路径走 @arkntools rebuild 按原对象大小
 * 预分配 buffer，变长后写入越界；现改为复用 encryptBundle 按新大小重排）。
 *
 * 链路：loadAssetBundle(pristine) → 对象 name（m_Name）→ encryptBundle(pristine, key, name, plain)
 *      → reload → 再解密比对。
 */
describe('kfbApplyToAsset 写回链路（变长重排）', () => {
  const KEY = 'e9d92700019be4f8a244a98871bef652052e74ff7d5961c71c57a33644af523e';
  const file = join(process.cwd(), 'scripts', '_717363977_modified.assetbundle');

  it('改数值后写回不抛越界且修改可还原', async () => {
    if (!existsSync(file)) {
      console.warn('skip: fixture not found', file);
      return;
    }
    const pristine = new Uint8Array(readFileSync(file));

    // 1. 模拟 assetManager 内部 loadAssetBundle
    const bundle = await loadAssetBundle(pristine.slice(0));
    expect(bundle).toBeTruthy();

    // 2. 先用 decryptBundle 拿到资源名 + 定位 pathId（模拟 app 内选中资源）
    const probe = await decryptBundle(pristine, KEY, '');
    expect(probe.name).toBeTruthy();

    let pathId: bigint | null = null;
    let objName = '';
    for (const obj of bundle.objects) {
      // 对象 name = TextAsset m_Name（readAlignedString 读的第一个字符串），与 find() 匹配一致
      if (obj.name === probe.name) {
        pathId = obj.pathId;
        objName = obj.name;
        break;
      }
    }
    expect(pathId).not.toBeNull();
    expect(objName).toBe(probe.name);

    // 3. kfbApplyToAsset 核心：用对象 name（m_Name）传给 encryptBundle（修复后命名来源）
    const name = objName;

    // 4. 解码 → 改一个数值（含 0→1 变长重排场景；跳过 $tid 等元字段）
    const views = await decodeKfb(probe.plain);
    const sem = JSON.parse(views.semantic);
    const targetKey = Object.keys(sem).find((k) => typeof sem[k] === 'number' && !k.startsWith('$'));
    expect(targetKey).toBeTruthy();
    const oldVal = sem[targetKey!];
    sem[targetKey!] = oldVal + 1;
    const newKfb = await encodeKfb(JSON.stringify(sem), 'semantic');
    expect(newKfb.length).toBeGreaterThan(0);

    // 5. encryptBundle 写回（修复后唯一路径）—— 不抛 offset is out of bounds
    let out: Uint8Array;
    try {
      out = await encryptBundle(pristine, KEY, name, newKfb, { unityFs: true });
    } catch (e) {
      throw new Error('写回抛错（应为 0）：' + String(e).slice(0, 120));
    }
    expect(out.length).toBeGreaterThan(0);

    // 6. reload（kfbApplyToAsset 末尾 loadAssetBundle(out)）
    const bundle2 = await loadAssetBundle(out.slice(0));
    expect(bundle2).toBeTruthy();
    const obj2 = bundle2.objectMap.get(pathId!);
    expect(obj2?.name).toBe(name);

    // 7. 再解密比对修改是否持久化
    const ext2 = await decryptBundle(out, KEY, '');
    const sem2 = JSON.parse((await decodeKfb(ext2.plain)).semantic);
    expect(sem2[targetKey!]).toBe(oldVal + 1);

    // 其余字段全一致
    const keys = Object.keys(sem);
    let diff = 0;
    for (const k of keys) {
      if (k === targetKey) continue;
      if (JSON.stringify(sem[k]) !== JSON.stringify(sem2[k])) diff++;
    }
    expect(diff).toBe(0);
  });
});
