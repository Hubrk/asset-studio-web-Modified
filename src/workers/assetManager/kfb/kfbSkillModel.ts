/**
 * KFB 技能语义模型
 * -----------------
 * 在原始 semantic JSON 之上，抽取"人类可读"的技能参数：
 *  - 技能 CD / 能量：来自全树的 SetSkillArg(1092) / SetSkillEpAttributeArg(1107) / ChangeSkillIcon(1068) 脚本
 *  - 技能范围（攻击判定盒）：来自 clipsDataList[i].keyframes[j].boxData 的各定点字段
 *
 * 设计原则：
 *  - 模型持有指向 sem 内部对象的【引用】，编辑时直接改引用对象；不动、未编辑的字段保持原始字节串，
 *    保证写回时尽力无损（仅被用户改过的分量才会被重新编码）。
 *  - 攻击判定盒是 2^32 定点数（scale = 2^32），字段形如 "x,y,z"（可能含空分量，空=0）。
 */
export const FIXED_SCALE = 4294967296; // 2^32

export interface BoxComponent {
  /** 原始分量文本（空字符串表示 0），未编辑时原样写回 */
  text: string;
  /** 展示用浮点值 = int / FIXED_SCALE */
  value: number;
  /** 用户是否编辑过该分量 */
  edited: boolean;
}

export interface BoxField {
  /** boxData 中的字段名，如 hurt_pos0 */
  field: string;
  /** boxData 对象引用（写回时直接改动它） */
  ref: any;
  /** 该字段原始字符串 */
  orig: string;
  /** 三个分量 */
  parts: BoxComponent[];
}

export interface ClipRange {
  /** 帧索引（字符串，keyframes 是字典） */
  frame: string;
  /** 该帧的攻击判定盒字段 */
  box: BoxField[];
}

export interface ClipModel {
  name: string;
  loop: boolean;
  totalframes: number;
  /** 仅含出现 boxData 的帧 */
  ranges: ClipRange[];
}

export interface CdEntry {
  /** 引用脚本对象，直接改动 */
  ref: any;
  actionId: number;
  enableSetEnable: boolean;
  isEnable: boolean;
  enabelSetCD: boolean;
  isIgnoreCD: boolean;
  enableSetManacost: boolean;
  isIgnoreManacost: boolean;
  enableSetUseful: boolean;
  isUseful: boolean;
}

export interface EpEntry {
  ref: any;
  actionId: number;
  enable: boolean;
  skillCD: number;
  maxEpCount: number;
  initEpCount: number;
  chargeConsumeFrameCount: number;
}

export interface IconEntry {
  ref: any;
  actionId: number;
  iconId: string;
  CDIndex: number;
  maxMana: number;
  IsRecordSkillCD: boolean;
}

/** SetMultiStateSkillArg(1148).stateInfos 中的单个状态项 */
export interface MultiStateInfo {
  ref: any;
  stateIndex: number;
  /** CD 数值（实测新版本恒为 0，真实秒数走外部配置表） */
  skillCD: number;
  skillIcon: string;
  /** 该状态激活的帧号 */
  activeFrame: number;
  /** CD 计时起点方式（1=释放时起算等） */
  startCDTimeStyle: number;
}

/** SetMultiStateSkillArg(1148)：多段/多态技能，含 stateInfos 列表 */
export interface MultiStateSkill {
  ref: any;
  actionId: number;
  reset: boolean;
  incMp: number;
  waitBreakFrameCount: number;
  states: MultiStateInfo[];
}

/** AcceptVKeyArg(1007)：接招点是否检查 CD / 封印 */
export interface AcceptCdEntry {
  ref: any;
  actionId: number;
  argInt: number;
  argStr: string;
  checkIsInCD: boolean;
  checkIsSealed: boolean;
}

export interface SkillGroup {
  actionId: number;
  cd: CdEntry[];
  ep: EpEntry[];
  icons: IconEntry[];
  multi: MultiStateSkill[];
  accept: AcceptCdEntry[];
}

/** CancelActionArg(1008)：取消规则，cancelVkeyGroups 中每一项是一个允许取消的按键组 */
export interface CancelVkeyItem {
  /** CancelVkeyGroup 对象引用（写回时直接改） */
  ref: any;
  /** 允许取消的按键 vKey */
  vKey: number;
  /** 限制步数（0=无限制） */
  limitStep: number;
  /** 限制摇杆 Y（0=无限制） */
  limitMapY: number;
  /** 最大摇杆 Y（0=无限制） */
  maxMapY: number;
}

export interface CancelRule {
  /** CancelActionArg 脚本对象引用 */
  ref: any;
  /** 是否清空已有取消规则 */
  clear: boolean;
  /** 允许取消的按键组列表 */
  groups: CancelVkeyItem[];
}

export interface CancelClip {
  name: string;
  totalframes: number;
  /** 帧号（字符串，keyframes 字典键）→ 该帧的取消规则（可能多组） */
  rules: { frame: string; list: CancelRule[] }[];
}

/** MoveActionArg / 位移参数脚本（通过 vx/vy/fRate 控制突进） */
export interface MoveArg {
  /** 脚本对象引用 */
  ref: any;
  scriptType: number;
  /** kfbType 字符串标识 */
  kfbType: string;
  /** 水平速度（定点 2^32 编码） */
  vx: number;
  /** 垂直速度（定点 2^32 编码） */
  vy: number;
  /** 前向速度倍率（定点 2^32 编码，默认 1.0） */
  fRate: number;
  /** 是否为朝向相关（跟随朝向翻转 vx） */
  useFace?: boolean;
}

export interface MoveClip {
  name: string;
  totalframes: number;
  /** 帧号 → 该帧的位移参数 */
  moves: { frame: string; list: MoveArg[] }[];
}

export interface SkillModel {
  skills: SkillGroup[];
  clips: ClipModel[];
  cancels: CancelClip[];
  moves: MoveClip[];
}

/** 递归遍历语义树，对每个对象调用 fn（含叶子） */
function walk(obj: any, fn: (node: any) => void): void {
  if (obj == null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const v of obj) walk(v, fn);
    return;
  }
  fn(obj);
  for (const k of Object.keys(obj)) walk(obj[k], fn);
}

/** 解析 "x,y,z" 定点字符串为浮点分量数组（空分量=0） */
export function parseFixedVec(s: unknown): number[] {
  if (typeof s !== 'string') return [];
  return s.split(',').map((c) => {
    const t = c.trim();
    if (t === '') return 0;
    const n = Number(t);
    return Number.isFinite(n) ? n / FIXED_SCALE : 0;
  });
}

/** 浮点分量 → 定点整数 */
export function floatToFixed(v: number): number {
  return Math.round((Number.isFinite(v) ? v : 0) * FIXED_SCALE);
}

/** 从 boxData 对象构建 BoxField 列表（保持字段顺序稳定） */
function buildBoxFields(boxData: any): BoxField[] {
  const ORDER = [
    'attack_pos', 'attack_size', 'weapon_pos', 'weapon_size',
    'hurt_pos0', 'hurt_size0', 'hurt_pos1', 'hurt_size1', 'hurt_pos2', 'hurt_size2',
  ];
  const fields: BoxField[] = [];
  for (const field of ORDER) {
    if (typeof boxData?.[field] !== 'string') continue;
    const orig = boxData[field];
    const parts = orig.split(',').map((c) => {
      const t = c.trim();
      return { text: t, value: t === '' ? 0 : Number(t) / FIXED_SCALE, edited: false };
    });
    fields.push({ field, ref: boxData, orig, parts });
  }
  return fields;
}

/** 把某个被编辑过的分量写回 boxData 字段（未编辑分量保持原文本） */
export function flushBoxField(f: BoxField): void {
  if (!f.ref) return;
  const comps = f.parts.map((p) => (p.edited ? String(floatToFixed(p.value)) : p.text));
  f.ref[f.field] = comps.join(',');
}

/** 构建技能语义模型（读 sem，收集引用，不改动数据） */
export function buildSkillModel(sem: any): SkillModel {
  const cd: CdEntry[] = [];
  const ep: EpEntry[] = [];
  const icons: IconEntry[] = [];
  const multi: MultiStateSkill[] = [];
  const accept: AcceptCdEntry[] = [];

  // 全树收集三类脚本（CD/EP 脚本可能出现在 objectFrames 或 clip 帧内，位置无关地收集）
  walk(sem, (node) => {
    if (!node || typeof node.scriptType !== 'number') return;
    if (node.scriptType === 1092) {
      cd.push({
        ref: node,
        actionId: node.actionId ?? 0,
        enableSetEnable: node.enableSetEnable ?? false,
        isEnable: node.isEnable ?? false,
        enabelSetCD: node.enabelSetCD ?? false,
        isIgnoreCD: node.isIgnoreCD ?? false,
        enableSetManacost: node.enableSetManacost ?? false,
        isIgnoreManacost: node.isIgnoreManacost ?? false,
        enableSetUseful: node.enableSetUseful ?? false,
        isUseful: node.isUseful ?? false,
      });
    } else if (node.scriptType === 1107) {
      // SetSkillEpAttributeArg：EP 上限 / 初始 EP / 技能 CD
      ep.push({
        ref: node,
        actionId: node.actionId ?? 0,
        enable: node.enable ?? false,
        skillCD: node.skillCD ?? 0,
        maxEpCount: node.maxEpCount ?? 0,
        initEpCount: node.initEpCount ?? 0,
        chargeConsumeFrameCount: node.chargeConsumeFrameCount ?? 0,
      });
    } else if (node.scriptType === 1068) {
      // ChangeSkillIcon：技能图标 / CDIndex / maxMana
      icons.push({
        ref: node,
        actionId: node.argInt ?? 0,
        iconId: node.argStr ?? '',
        CDIndex: node.CDIndex ?? -1,
        maxMana: node.maxMana ?? -1,
        IsRecordSkillCD: node.IsRecordSkillCD ?? false,
      });
    } else if (node.scriptType === 1148) {
      // SetMultiStateSkillArg：多段技能状态（stateInfos）
      multi.push({
        ref: node,
        actionId: node.actionId ?? 0,
        reset: node.reset ?? false,
        incMp: node.incMp ?? 1,
        waitBreakFrameCount: node.waitBreakFrameCount ?? 0,
        states: Array.isArray(node.stateInfos)
          ? node.stateInfos.map((s: any) => ({
              ref: s,
              stateIndex: s.stateIndex ?? 0,
              skillCD: s.skillCD ?? 0,
              skillIcon: s.skillIcon ?? '',
              activeFrame: s.activeFrame ?? 0,
              startCDTimeStyle: s.startCDTimeStyle ?? 1,
            }))
          : [],
      });
    } else if (node.scriptType === 1007) {
      // AcceptVKeyArg：接招点是否检查 CD / 封印（actionId 与 ChangeSkillIcon 同源，取 argInt）
      accept.push({
        ref: node,
        actionId: node.argInt ?? 0,
        argInt: node.argInt ?? 0,
        argStr: String(node.argStr ?? ''),
        checkIsInCD: node.checkIsInCD ?? false,
        checkIsSealed: node.checkIsSealed ?? false,
      });
    }
  });

  // 按 actionId 分组
  const byAction = new Map<number, SkillGroup>();
  const ensure = (actionId: number): SkillGroup => {
    let g = byAction.get(actionId);
    if (!g) {
      g = { actionId, cd: [], ep: [], icons: [], multi: [], accept: [] };
      byAction.set(actionId, g);
    }
    return g;
  };
  for (const e of cd) ensure(e.actionId).cd.push(e);
  for (const e of ep) ensure(e.actionId).ep.push(e);
  for (const e of icons) ensure(e.actionId).icons.push(e);
  for (const m of multi) ensure(m.actionId).multi.push(m);
  for (const a of accept) ensure(a.actionId).accept.push(a);
  const skills = [...byAction.values()].sort((a, b) => a.actionId - b.actionId);

  // 范围：clip 的 keyframes → boxData
  const clips: ClipModel[] = [];
  const clipsDataList = sem?.clipsDataList;
  if (Array.isArray(clipsDataList)) {
    for (const clip of clipsDataList) {
      const model: ClipModel = {
        name: clip?.name ?? '',
        loop: clip?.loop ?? false,
        totalframes: clip?.totalframes ?? 0,
        ranges: [],
      };
      const kf = clip?.keyframes;
      if (kf && typeof kf === 'object') {
        for (const frame of Object.keys(kf)) {
          const boxData = kf[frame]?.boxData;
          if (boxData && typeof boxData === 'object') {
            model.ranges.push({ frame, box: buildBoxFields(boxData) });
          }
        }
      }
      clips.push(model);
    }
  }

  // 取消规则 & 位移：clip 的 keyframes → 帧 scriptDatas
  const cancels: CancelClip[] = [];
  const moves: MoveClip[] = [];
  if (Array.isArray(clipsDataList)) {
    for (const clip of clipsDataList) {
      const name = clip?.name ?? '';
      const totalframes = clip?.totalframes ?? 0;
      const cancelClip: CancelClip = { name, totalframes, rules: [] };
      const moveClip: MoveClip = { name, totalframes, moves: [] };
      const kf = clip?.keyframes;
      if (kf && typeof kf === 'object') {
        for (const frame of Object.keys(kf)) {
          const fd = kf[frame]?.frameData;
          const sds = fd?.scriptDatas;
          if (Array.isArray(sds)) {
            // CancelActionArg (1008)
            const rulesThisFrame: CancelRule[] = [];
            for (const s of sds) {
              if (s?.scriptType !== 1008) continue;
              const groups: CancelVkeyItem[] = [];
              const cgs = s.cancelVkeyGroups;
              if (Array.isArray(cgs)) {
                for (const g of cgs) {
                  const fields = g?.Fields;
                  groups.push({
                    ref: fields ?? g,
                    vKey: Number(fields?.vKey ?? g?.vKey ?? 0),
                    limitStep: Number(fields?.limitStep ?? g?.limitStep ?? 0),
                    limitMapY: Number(fields?.limitMapY ?? g?.limitMapY ?? 0),
                    maxMapY: Number(fields?.maxMapY ?? g?.maxMapY ?? 0),
                  });
                }
              }
              rulesThisFrame.push({
                ref: s,
                clear: !!s.clear,
                groups,
              });
            }
            if (rulesThisFrame.length) cancelClip.rules.push({ frame, list: rulesThisFrame });
            // 位移参数：含 vx/vy/fRate 字段的脚本（MoveActionArg 等多种）
            const movesThisFrame: MoveArg[] = [];
            for (const s of sds) {
              if (!s) continue;
              const hasVx = typeof s.vx === 'number';
              const hasVy = typeof s.vy === 'number';
              const hasFRate = typeof s.fRate === 'number';
              if (!hasVx && !hasVy && !hasFRate) continue;
              movesThisFrame.push({
                ref: s,
                scriptType: Number(s.scriptType ?? 0),
                kfbType: String(s.kfbType ?? ''),
                vx: hasVx ? s.vx : 0,
                vy: hasVy ? s.vy : 0,
                fRate: hasFRate ? s.fRate : 0,
                useFace: typeof s.useFace === 'boolean' ? s.useFace : undefined,
              });
            }
            if (movesThisFrame.length) moveClip.moves.push({ frame, list: movesThisFrame });
          }
        }
      }
      cancels.push(cancelClip);
      moves.push(moveClip);
    }
  }

  return { skills, clips, cancels, moves };
}

/** 把编辑后的 CancelVkeyItem 写回原始 sem 对象（vKey 等数值字段直接赋值给 ref） */
export function flushCancelGroup(g: CancelVkeyItem): void {
  if (!g.ref) return;
  g.ref.vKey = g.vKey;
  g.ref.limitStep = g.limitStep;
  g.ref.limitMapY = g.limitMapY;
  g.ref.maxMapY = g.maxMapY;
}

/** 把编辑后的 MoveArg 写回原始 sem 对象 */
export function flushMoveArg(m: MoveArg): void {
  if (!m.ref) return;
  if (typeof m.ref.vx === 'number') m.ref.vx = m.vx;
  if (typeof m.ref.vy === 'number') m.ref.vy = m.vy;
  if (typeof m.ref.fRate === 'number') m.ref.fRate = m.fRate;
  if (m.useFace !== undefined && typeof m.ref.useFace === 'boolean') m.ref.useFace = m.useFace;
}

/** 向 CancelRule 追加一个 vKey 按键组（如果不存在），返回是否新增 */
export function addCancelVkey(rule: CancelRule, vKey: number): boolean {
  if (rule.groups.some((g) => g.vKey === vKey)) return false;
  // 从 rule.ref 原始对象拿 cancelVkeyGroups，追加新 Item（mirror kfb_schema 的结构）
  const cgs = rule.ref.cancelVkeyGroups;
  if (!Array.isArray(cgs)) {
    rule.ref.cancelVkeyGroups = [];
  }
  const newItem = {
    Fields: { vKey, limitStep: 0, limitMapY: 0, maxMapY: 0 },
  };
  rule.ref.cancelVkeyGroups.push(newItem);
  rule.groups.push({
    ref: newItem.Fields,
    vKey,
    limitStep: 0,
    limitMapY: 0,
    maxMapY: 0,
  });
  return true;
}

/** 从 CancelRule 移除一个 vKey，返回是否移除 */
export function removeCancelVkey(rule: CancelRule, vKey: number): boolean {
  const idx = rule.groups.findIndex((g) => g.vKey === vKey);
  if (idx < 0) return false;
  rule.groups.splice(idx, 1);
  // 同时从原始数组中移除
  const cgs = rule.ref.cancelVkeyGroups;
  if (Array.isArray(cgs)) {
    const ri = cgs.findIndex((x: any) => Number(x?.Fields?.vKey ?? x?.vKey) === vKey);
    if (ri >= 0) cgs.splice(ri, 1);
  }
  return true;
}

// ─────────────── 连招链分析 ───────────────

export interface ComboTransfer {
  /** 出现该转移的帧号（keyframes 字典键） */
  frame: string;
  /** 转移类型：accept-vkey=接收按键衔接连招 / jump=跳转到目标帧 / end-frame=动作结束帧 */
  type: 'accept-vkey' | 'jump' | 'end-frame';
  /** accept-vkey: 按键类型（如 1005=普攻）；jump: 目标帧 index */
  argInt: number;
  /** accept-vkey: 连招段号（"1"/"2"/…，段号决定衔接到下一个动作） */
  argStr: string;
  /** accept-vkey: 具体按键值列表 */
  vkeys: number[];
  /** 脚本对象引用（可编辑 argInt/argStr 后写回） */
  ref: any;
}

export interface ComboClip {
  name: string;
  totalframes: number;
  loop: boolean;
  transfers: ComboTransfer[];
}

/**
 * 构建连招链：遍历每个动作 clip 的帧，抽取「转移点」——
 *  - AcceptVKeyArg(1007)：该帧接收指定按键，玩家在此时再按即可衔接连招下一段
 *  - KHScriptData(1031)：跳转到目标帧（argInt）
 *  - etype=999：动作结束帧
 * 编辑时直接改 transfer.ref，与技能模型共用 write-back 链路。
 */
export function buildComboChain(sem: any): ComboClip[] {
  const clipsDataList = sem?.clipsDataList;
  if (!Array.isArray(clipsDataList)) return [];
  const out: ComboClip[] = [];
  for (const clip of clipsDataList) {
    const model: ComboClip = {
      name: clip?.name ?? '',
      totalframes: clip?.totalframes ?? 0,
      loop: clip?.loop ?? false,
      transfers: [],
    };
    const kf = clip?.keyframes;
    if (kf && typeof kf === 'object') {
      for (const frame of Object.keys(kf)) {
        const kdata = kf[frame];
        const etype = Number(kdata?.eventType ?? 0);
        if (etype === 999) {
          model.transfers.push({ frame, type: 'end-frame', argInt: 0, argStr: '', vkeys: [], ref: kdata });
        }
        const fd = kdata?.frameData;
        if (fd && Array.isArray(fd.scriptDatas)) {
          for (const s of fd.scriptDatas) {
            if (!s || typeof s.scriptType !== 'number') continue;
            if (s.scriptType === 1007) {
              model.transfers.push({
                frame,
                type: 'accept-vkey',
                argInt: s.argInt,
                argStr: String(s.argStr ?? ''),
                vkeys: flattenVkeys(s.vkeys),
                ref: s,
              });
            } else if (s.scriptType === 1031) {
              model.transfers.push({
                frame,
                type: 'jump',
                argInt: s.argInt,
                argStr: '',
                vkeys: [],
                ref: s,
              });
            }
          }
        }
      }
    }
    out.push(model);
  }
  return out;
}

/** AcceptVKey.vkeys 是嵌套数组（list[list[int]]），扁平回收按键值 */
function flattenVkeys(vkeys: unknown): number[] {
  const res: number[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      res.push(v);
    }
  };
  visit(vkeys);
  return res;
}