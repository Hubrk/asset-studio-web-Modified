import { describe, expect, it } from 'vitest';
import {
  buildSkillModel,
  buildComboChain,
  parseFixedVec,
  floatToFixed,
  flushBoxField,
  FIXED_SCALE,
} from '../../workers/assetManager/kfb/kfbSkillModel';

/** 构造一个最小可用的 semantic 数据（含 CD/EP/图标脚本 + 一个带攻击盒的 clip） */
function makeSem() {
  return {
    $tid: 1,
    objectFrames: {
      '9005901': {
        $tid: 2,
        index: 9005901,
        scriptDatas: [
          { $tid: 10, scriptType: 1092, actionId: 38, enableSetEnable: true, enabelSetCD: false, isIgnoreCD: true },
          { $tid: 11, scriptType: 1107, actionId: 38, enable: true, skillCD: 120, maxEpCount: 2, initEpCount: 2 },
          { $tid: 12, scriptType: 1068, argInt: 38, argStr: '9001403', CDIndex: -1, maxMana: -1, IsRecordSkillCD: false },
        ],
      },
    },
    clipsDataList: [
      {
        $tid: 20,
        name: 'skill_B_1_1',
        loop: false,
        totalframes: 73,
        keyframes: {
          '0': {
            $tid: 21,
            index: 0,
            boxData: {
              $tid: 22,
              attack_pos: `${FIXED_SCALE},0,0`,
              hurt_pos0: '0,0,0',
              hurt_size0: '1,,2', // 空分量 = 0
            },
          },
        },
      },
      {
        $tid: 30,
        name: 'idle',
        loop: true,
        totalframes: 70,
        keyframes: { '0': { $tid: 31, index: 0 } }, // 无 boxData
      },
    ],
  };
}

describe('kfbSkillModel', () => {
  it('收集 CD/EP/图标脚本并按 actionId 分组', () => {
    const m = buildSkillModel(makeSem());
    expect(m.skills.length).toBe(1);
    const g = m.skills[0];
    expect(g.actionId).toBe(38);
    expect(g.cd.length).toBe(1);
    expect(g.cd[0].enabelSetCD).toBe(false);
    expect(g.cd[0].isIgnoreCD).toBe(true);
    expect(g.ep.length).toBe(1);
    expect(g.ep[0].skillCD).toBe(120);
    expect(g.icons.length).toBe(1);
    expect(g.icons[0].CDIndex).toBe(-1);
  });

  it('收集含攻击盒的 clip，忽略无盒帧', () => {
    const m = buildSkillModel(makeSem());
    expect(m.clips.length).toBe(2);
    const skill = m.clips[0];
    expect(skill.ranges.length).toBe(1);
    expect(skill.ranges[0].frame).toBe('0');
    // 10 个盒字段只保留出现者
    const fieldNames = skill.ranges[0].box.map((b) => b.field);
    expect(fieldNames).toEqual(['attack_pos', 'hurt_pos0', 'hurt_size0']);
  });

  it('定点解析为空分量补 0，浮点往返一致', () => {
    expect(floatToFixed(1)).toBe(FIXED_SCALE);
    expect(floatToFixed(0)).toBe(0);
    expect(parseFixedVec('1,,-2')).toEqual([1 / FIXED_SCALE, 0, -2 / FIXED_SCALE]);
    // 往返：1.5 → int → 再除回 ≈ 1.5
    const f = 1.5;
    expect(floatToFixed(f) / FIXED_SCALE).toBeCloseTo(f, 6);
  });

  it('flushBoxField 只覆写被编辑的分量，未编辑分量保持原始文本', () => {
    const sem = makeSem();
    const m = buildSkillModel(sem);
    const boxField = m.clips[0].ranges[0].box[2]; // hurt_size0 = "1,,2"
    expect(boxField.orig).toBe('1,,2');

    // 编辑中间分量（原为空=0）为 0.5
    boxField.parts[1].value = 0.5;
    boxField.parts[1].edited = true;
    flushBoxField(boxField);

    // 第 1、3 分量保持原文本 "1","2"，中间分量被编码为 0.5*2^32
    const out = boxField.ref.hurt_size0;
    const comps = out.split(',');
    expect(comps[0]).toBe('1');
    expect(comps[2]).toBe('2');
    expect(Number(comps[1])).toBe(floatToFixed(0.5));
  });

  it('未编辑任何分量时 flush 不改变原始字符串', () => {
    const sem = makeSem();
    const m = buildSkillModel(sem);
    const boxField = m.clips[0].ranges[0].box[0]; // attack_pos
    flushBoxField(boxField);
    expect(boxField.ref.attack_pos).toBe(`${FIXED_SCALE},0,0`);
  });
});

describe('buildComboChain', () => {
  function makeComboSem() {
    return {
      clipsDataList: [
        {
          name: 'attack1',
          totalframes: 10,
          loop: false,
          keyframes: {
            '8': {
              eventType: 0,
              frameData: {
                scriptDatas: [
                  { scriptType: 1007, argInt: 1005, argStr: '1', vkeys: [[11]] },
                ],
              },
            },
            '15': { eventType: 999 },
          },
        },
        {
          name: 'skill_B',
          totalframes: 30,
          loop: false,
          keyframes: {
            '6': {
              eventType: 0,
              frameData: {
                scriptDatas: [
                  { scriptType: 1031, argInt: 9005923 },
                ],
              },
            },
          },
        },
      ],
    };
  }

  it('抽取接招 / 跳转 / 结束三类转移点', () => {
    const chain = buildComboChain(makeComboSem());
    const atk = chain.find((c) => c.name === 'attack1');
    expect(atk!.transfers).toHaveLength(2);
    const accept = atk!.transfers.find((t) => t.type === 'accept-vkey')!;
    expect(accept.frame).toBe('8');
    expect(accept.argInt).toBe(1005);
    expect(accept.argStr).toBe('1');
    expect(accept.vkeys).toEqual([11]);
    const end = atk!.transfers.find((t) => t.type === 'end-frame')!;
    expect(end.frame).toBe('15');

    const skill = chain.find((c) => c.name === 'skill_B')!;
    const jump = skill.transfers.find((t) => t.type === 'jump')!;
    expect(jump.argInt).toBe(9005923);
  });

  it('编辑接招段号写回引用对象', () => {
    const sem = makeComboSem();
    const chain = buildComboChain(sem);
    const accept = chain.find((c) => c.name === 'attack1')!.transfers.find((t) => t.type === 'accept-vkey')!;
    accept.ref.argStr = 2;
    expect(sem.clipsDataList[0].keyframes['8'].frameData.scriptDatas[0].argStr).toBe(2);
  });
});