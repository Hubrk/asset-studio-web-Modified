import { describe, it, expect } from 'vitest';
import { extractKfbRefs, validateRefs, extractTargetFromArgStr } from '../../workers/assetManager/kfb/kfbRefs';

// ============================================================================
// KFB 跨文件引用提取与校验的单测
// 用例覆盖：CreateInteractArg(10001) / scriptType=1044 / scriptType=1031
// 以及 objectFrames 和 clipsDataList 两条遍历路径。
// ============================================================================

// 模拟一个真实的 KFB semantic 结构（简化版，只保留引用相关字段）
const mockSem = {
  objectFrames: {
    '9005981': {
      frameData: {
        scriptDatas: [
          { scriptType: 1044, argInt: 80203, argStr: '_scriptnotnull_90059802b' },
          { scriptType: 1031, argInt: 9998, argStr: '' },
          { scriptType: 1031, argInt: 100, argStr: '' }, // 短 argInt，不应被收集
        ],
      },
    },
    '9005982': {
      frameData: {
        scriptDatas: [
          { scriptType: 1044, argInt: 80201, argStr: '_script_90059802b' },
        ],
      },
    },
  },
  clipsDataList: [
    {
      name: 'Ultra_kill_1',
      keyframes: {
        '0': {
          frameData: {
            scriptDatas: [
              { scriptType: 10001, assetId: '90059401', argInt: 0, argStr: '' },
              { scriptType: 10001, assetId: '90059403', argInt: 0, argStr: '' },
            ],
          },
        },
        '15': {
          frameData: {
            scriptDatas: [
              { scriptType: 10001, assetId: '', argInt: 0, argStr: '' }, // 空 assetId，不应收集
            ],
          },
        },
      },
    },
    {
      name: 'attack1',
      keyframes: {
        '0': {
          frameData: {
            scriptDatas: [
              { scriptType: 1031, argInt: 9005923, argStr: '' },
              { scriptType: 10001, assetId: '90059101', argInt: 0, argStr: '' },
            ],
          },
        },
      },
    },
  ],
};

describe('extractTargetFromArgStr', () => {
  it('从 _script_90059403b 提取 90059403', () => {
    expect(extractTargetFromArgStr('_script_90059403b')).toBe('90059403');
  });

  it('从 _scriptnotnull_90059802b 提取 90059802', () => {
    expect(extractTargetFromArgStr('_scriptnotnull_90059802b')).toBe('90059802');
  });

  it('空字符串返回空', () => {
    expect(extractTargetFromArgStr('')).toBe('');
  });

  it('无数字返回空', () => {
    expect(extractTargetFromArgStr('_script_abc')).toBe('');
  });

  it('非 _script 前缀的特殊标记返回空（不误判为文件引用）', () => {
    expect(extractTargetFromArgStr('self_rune')).toBe('');
    expect(extractTargetFromArgStr('_self_psychic')).toBe('');
    expect(extractTargetFromArgStr('_self_12345_together')).toBe('');
  });

  it('多数字段取最后一个（真实目标名在结尾）', () => {
    expect(extractTargetFromArgStr('_script_90059101_and_90059401')).toBe('90059401');
  });
});

describe('extractKfbRefs', () => {
  const refs = extractKfbRefs(mockSem);

  it('提取所有 interact 引用（10001）', () => {
    const interact = refs.filter((r) => r.kind === 'interact');
    expect(interact).toHaveLength(3);
    expect(interact.map((r) => r.target).sort()).toEqual(['90059101', '90059401', '90059403']);
  });

  it('提取所有 jump 引用（1044）', () => {
    const jump = refs.filter((r) => r.kind === 'jump');
    expect(jump).toHaveLength(2);
    expect(jump.every((r) => r.target === '90059802')).toBe(true);
  });

  it('提取 global 引用（1031），仅 4 位以上', () => {
    const global = refs.filter((r) => r.kind === 'global');
    expect(global).toHaveLength(2);
    expect(global.map((r) => r.target).sort()).toEqual(['9005923', '9998']);
  });

  it('sourcePath 包含来源信息', () => {
    const interact = refs.find((r) => r.kind === 'interact' && r.target === '90059401');
    expect(interact).toBeDefined();
    expect(interact!.sourcePath).toContain('Ultra_kill_1');
    expect(interact!.sourcePath.some((p) => p.includes('scriptType=10001'))).toBe(true);
  });

  it('objectFrames 路径被正确标注', () => {
    const jump = refs.find((r) => r.kind === 'jump');
    expect(jump).toBeDefined();
    expect(jump!.sourcePath).toContain('objectFrames');
  });

  it('空对象返回空数组', () => {
    expect(extractKfbRefs(null)).toEqual([]);
    expect(extractKfbRefs({})).toEqual([]);
    expect(extractKfbRefs('not an object')).toEqual([]);
  });
});

describe('validateRefs', () => {
  const refs = extractKfbRefs(mockSem);

  it('所有目标都存在时返回 ok', () => {
    const available = ['90059101', '90059401', '90059403', '90059802', '90059801', '90059'];
    const { ok, broken } = validateRefs(refs, available);
    expect(ok).toBe(true);
    expect(broken).toHaveLength(0);
  });

  it('缺失目标时返回 broken', () => {
    // 90059403 和 90059802 不在列表中
    const available = ['90059101', '90059401', '90059801', '90059'];
    const { ok, broken } = validateRefs(refs, available);
    expect(ok).toBe(false);
    const brokenTargets = [...new Set(broken.map((b) => b.target))].sort();
    expect(brokenTargets).toEqual(['90059403', '90059802']);
  });

  it('global 引用不参与拦截', () => {
    // 即使 global 的 target 不在列表中，也不应出现在 broken
    const available = ['90059101', '90059401', '90059403', '90059802'];
    const { broken } = validateRefs(refs, available);
    expect(broken.every((r) => r.kind !== 'global')).toBe(true);
  });

  it('空引用列表返回 ok', () => {
    const { ok, broken } = validateRefs([], ['any']);
    expect(ok).toBe(true);
    expect(broken).toHaveLength(0);
  });
});
