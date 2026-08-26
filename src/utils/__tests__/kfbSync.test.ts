import { describe, it, expect } from 'vitest';
import {
  findActorPair,
  isActorVariantName,
  diffObjects,
  setByPath,
  getByPath,
  type FieldDiff,
} from '../../workers/assetManager/kfb/kfbSync';
import { findChainNode, type ChainNode } from '../../workers/assetManager/kfb/kfbRefs';

// ============================================================================
// 双 ActorData 同步 + 技能链可视化 单测
// ============================================================================

describe('findActorPair', () => {
  it('本体 90059 → 变体 90059_p', () => {
    expect(findActorPair('90059')).toBe('90059_p');
  });
  it('变体 90059_p → 本体 90059', () => {
    expect(findActorPair('90059_p')).toBe('90059');
  });
  it('变体 90059_p2 → 本体 90059', () => {
    expect(findActorPair('90059_p2')).toBe('90059');
  });
  it('非标准名也尝试 +_p', () => {
    expect(findActorPair('90382')).toBe('90382_p');
  });
  it('空名返回 undefined', () => {
    expect(findActorPair('')).toBeUndefined();
  });
});

describe('isActorVariantName', () => {
  it('_p → 变体', () => expect(isActorVariantName('90059_p')).toBe(true));
  it('_p2 → 变体', () => expect(isActorVariantName('90059_p2')).toBe(true));
  it('_p999 → 变体', () => expect(isActorVariantName('90059_p999')).toBe(true));
  it('纯数字 → 本体', () => expect(isActorVariantName('90059')).toBe(false));
  it('含 _p 但不在结尾 → 本体', () => expect(isActorVariantName('90_p_059')).toBe(false));
  it('空 → 本体', () => expect(isActorVariantName('')).toBe(false));
});

describe('diffObjects', () => {
  it('识别叶子标量差异', () => {
    const a = { x: 1, y: 'a', z: true };
    const b = { x: 2, y: 'a', z: true };
    const diffs = diffObjects(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toEqual(['x']);
    expect(diffs[0].leaf).toBe(true);
    expect(diffs[0].aLabel).toBe('1');
    expect(diffs[0].bLabel).toBe('2');
  });

  it('忽略 $tid', () => {
    const a = { $tid: 16, rate: 100 };
    const b = { $tid: 16, rate: 200 };
    const diffs = diffObjects(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toEqual(['rate']);
  });

  it('嵌套路径递归', () => {
    const a = { clips: [{ name: 'a', keyframes: { '5': { boxData: { size: '10' } } } }] };
    const b = { clips: [{ name: 'a', keyframes: { '5': { boxData: { size: '20' } } } }] };
    const diffs = diffObjects(a, b);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toEqual(['clips', 0, 'keyframes', '5', 'boxData', 'size']);
  });

  it('数组长度不同 → 整体差异（不可同步）', () => {
    const a = { arr: [1, 2] };
    const b = { arr: [1, 2, 3] };
    const diffs = diffObjects(a, b);
    expect(diffs[0].leaf).toBe(false);
  });

  it('完全一致 → 无差异', () => {
    expect(diffObjects({ a: 1 }, { a: 1 })).toHaveLength(0);
  });

  it('一个叶子一个对象 → 不可同步差异', () => {
    const diffs = diffObjects({ f: '1' }, { f: { raw: 1 } });
    expect(diffs[0].leaf).toBe(false);
  });

  it('null vs 值', () => {
    const diffs = diffObjects({ f: null }, { f: 'abc' });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].leaf).toBe(true);
  });
});

describe('setByPath / getByPath', () => {
  it('按路径写入', () => {
    const obj = { clips: [{ keyframes: {} }] };
    const ok = setByPath(obj, ['clips', 0, 'keyframes', 'rate'], 99);
    expect(ok).toBe(true);
    expect(obj.clips[0].keyframes.rate).toBe(99);
  });

  it('父级缺失返回 false', () => {
    const obj = { a: 1 };
    expect(setByPath(obj, ['x', 'y'], 1)).toBe(false);
  });

  it('getByPath 读取存在值', () => {
    const obj = { a: { b: 'v' } };
    expect(getByPath(obj, ['a', 'b'])).toBe('v');
  });

  it('getByPath 不存在返回 undefined', () => {
    expect(getByPath({ a: 1 }, ['a', 'b'])).toBeUndefined();
  });
});

// ── 语义对齐：clipsDataList 按 listIndex/name 对齐，防止"同长但内容错位"的伪同步 ──
describe('diffObjects 语义对齐（clipsDataList / scriptDatas）', () => {
  it('clipsDataList 按 listIndex 对齐，索引错位但身份相同仍正确配对', () => {
    // 本体：Ultra_kill_1 listIndex=21 在前；变体：按 name 排序后 listIndex=21 在后
    const a = {
      clipsDataList: [
        { listIndex: 21, name: 'Ultra_kill_1', speed: 1.5 },
        { listIndex: 20, name: 'Ultra_kill_0', speed: 1.0 },
      ],
    };
    const b = {
      clipsDataList: [
        { listIndex: 20, name: 'Ultra_kill_0', speed: 1.0 },
        { listIndex: 21, name: 'Ultra_kill_1', speed: 1.2 }, // speed 与 A 不同
      ],
    };
    const diffs = diffObjects(a, b);
    // 应只有 1 处差异：listIndex=21 的 clip 的 speed
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toContain('key:21');   // 语义段，不是数字索引
    expect(diffs[0].path[diffs[0].path.length - 1]).toBe('speed');
    expect(diffs[0].leaf).toBe(true);
    expect(diffs[0].aLabel).toBe('1.5');
    expect(diffs[0].bLabel).toBe('1.2');
  });

  it('身份仅 A 侧存在，报"仅 A 侧"结构性差异', () => {
    const a = { clipsDataList: [{ listIndex: 21, speed: 1 }] };
    const b = { clipsDataList: [{ listIndex: 20, speed: 1 }] };
    const diffs = diffObjects(a, b);
    const onlyA = diffs.find((d) => d.bLabel.includes('仅 B 侧不存在')) ?? diffs.find((d) => d.path.includes('key:21'));
    expect(onlyA).toBeDefined();
    expect(onlyA!.leaf).toBe(false);
  });

  it('scriptDatas 按 scriptType 对齐', () => {
    const a = {
      clipsDataList: [
        {
          listIndex: 0,
          keyframes: {
            '0': { frameData: { scriptDatas: [{ scriptType: 10001, assetId: 'X' }] } },
          },
        },
      ],
    };
    const b = {
      clipsDataList: [
        {
          listIndex: 0,
          keyframes: {
            '0': { frameData: { scriptDatas: [{ scriptType: 10001, assetId: 'Y' }] } },
          },
        },
      ],
    };
    const diffs = diffObjects(a, b);
    const assetDiff = diffs.find((d) => (d.path as any[]).includes('assetId'));
    expect(assetDiff).toBeDefined();
    expect(assetDiff!.aLabel).toBe('"X"');
    expect(assetDiff!.bLabel).toBe('"Y"');
  });
});

// ── 语义路径 setByPath / getByPath 往返 ──
describe('语义路径 setByPath / getByPath', () => {
  it('按 clipsDataList listIndex 语义段读写', () => {
    const obj = {
      clipsDataList: [
        { listIndex: 20, speed: 1 },
        { listIndex: 21, speed: 1.5 },
      ],
    };
    expect(getByPath(obj, ['clipsDataList', 'key:21', 'speed'])).toBe(1.5);
    const ok = setByPath(obj, ['clipsDataList', 'key:21', 'speed'], 2.0);
    expect(ok).toBe(true);
    expect(obj.clipsDataList[1].speed).toBe(2.0); // 语义索引 21 对应数组索引 1
  });

  it('按 scriptDatas scriptType 语义段读写', () => {
    const obj = {
      clipsDataList: [
        {
          listIndex: 0,
          keyframes: {
            '0': { frameData: { scriptDatas: [{ scriptType: 10001, assetId: 'X' }] } },
          },
        },
      ],
    };
    const path = ['clipsDataList', 'key:0', 'keyframes', '0', 'frameData', 'scriptDatas', 'key:st=10001', 'assetId'];
    expect(getByPath(obj, path)).toBe('X');
    const ok = setByPath(obj, path, 'Z');
    expect(ok).toBe(true);
    expect(obj.clipsDataList[0].keyframes['0'].frameData.scriptDatas[0].assetId).toBe('Z');
  });

  it('语义身份找不到时 setByPath 返回 false', () => {
    const obj = { clipsDataList: [{ listIndex: 21, speed: 1 }] };
    expect(setByPath(obj, ['clipsDataList', 'key:999', 'speed'], 9)).toBe(false);
  });
});

describe('findChainNode', () => {
  const tree: ChainNode = {
    name: '90059',
    exists: true,
    loaded: true,
    children: [
      {
        name: '90059401',
        exists: true,
        loaded: false,
        children: [],
      },
      {
        name: '90059402',
        exists: false,
        loaded: false,
        children: [],
      },
    ],
  };

  it('找到根节点', () => {
    expect(findChainNode(tree, '90059')?.name).toBe('90059');
  });

  it('找到子节点', () => {
    expect(findChainNode(tree, '90059401')?.name).toBe('90059401');
    expect(findChainNode(tree, '90059402')?.exists).toBe(false);
  });

  it('找不到返回 null', () => {
    expect(findChainNode(tree, '99999999')).toBeNull();
  });
});
