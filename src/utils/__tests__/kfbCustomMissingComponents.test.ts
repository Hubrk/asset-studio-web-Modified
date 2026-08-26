import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decryptBundle } from '../../workers/assetManager/loaders/kfbBundle';
import { decodeKfb, encodeKfb } from '../../workers/assetManager/loaders/kfbCodec';
import { kfbKeyList } from '../../workers/assetManager/kfb/kfbKeys';

/**
 * 回归：用户内联编辑 KFB 时，"改 0→1 后写回"报
 * KfbEncodeError: expected an integer, got "" ($...boxData.hurt_pos0.z)
 * 根因：encodeCustom 的 parseCustomParts 对 custom 定点类型（KHAttackBox pos/size 等）
 * 缺分量补 ''（空串），integerValue('') 抛错。修复：缺分量补 '0'（缺省分量语义=0）。
 */
describe('KFB custom 定点字段缺分量容错', () => {
  const file =
    'C:/Users/34072/Desktop/90开头奥义图+帧动画+战斗逻辑/90114宇智波带土[忍界大战]/战斗逻辑/3301713855.assetbundle';

  async function loadSemantic(): Promise<{ sem: any; probe: { plain: Uint8Array } }> {
    const raw = new Uint8Array(readFileSync(file));
    let probe: { plain: Uint8Array } | null = null;
    for (const key of kfbKeyList) {
      try {
        probe = await decryptBundle(raw, key, '');
        break;
      } catch {
        /* try next */
      }
    }
    if (!probe) throw new Error('无法用内置 key 解密 3301713855.assetbundle');
    const views = await decodeKfb(probe.plain);
    return { sem: JSON.parse(views.semantic), probe };
  }

  it('缺分量定点字段不再抛错（补 0）', async () => {
    if (!existsSync(file)) {
      console.warn('skip: test file not found', file);
      return;
    }
    const { sem } = await loadSemantic();
    const box = sem.clipsDataList[0].keyframes[0].boxData;
    expect(box.hurt_pos0).toBeTypeOf('string');

    // 模拟用户编辑后字段缺分量（"x,y" 少一个分量）
    const s = JSON.parse(JSON.stringify(sem));
    s.clipsDataList[0].keyframes[0].boxData.hurt_pos0 = '1,2';
    let out: Uint8Array;
    try {
      out = await encodeKfb(JSON.stringify(s), 'semantic');
    } catch (e) {
      throw new Error('缺分量应被补 0 而非抛错：' + String(e).slice(0, 120));
    }
    expect(out.length).toBeGreaterThan(0);

    // 回读：缺的分量 z 被补为 0
    const views2 = await decodeKfb(out);
    const sem2 = JSON.parse(views2.semantic);
    expect(sem2.clipsDataList[0].keyframes[0].boxData.hurt_pos0).toBe('1,2,0');
  });

  it('正常数据 roundtrip 不受影响', async () => {
    if (!existsSync(file)) {
      console.warn('skip: test file not found', file);
      return;
    }
    const { probe, sem } = await loadSemantic();
    const original = sem.clipsDataList[0].keyframes[0].boxData.hurt_pos0;
    const out = await encodeKfb(JSON.stringify(sem), 'semantic');
    const views2 = await decodeKfb(out);
    const sem2 = JSON.parse(views2.semantic);
    expect(sem2.clipsDataList[0].keyframes[0].boxData.hurt_pos0).toBe(original);
    // 顶层数值字段 roundtrip 保持
    expect(sem2.sufferAudioID).toBe(sem.sufferAudioID);
  });
});
