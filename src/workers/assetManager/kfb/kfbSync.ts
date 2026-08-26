/**
 * KFB 双 ActorData 同步工具
 * -------------------------
 * 角色本体（如 90059）与 P 变体（如 90059_p）是两份 95% 一致、但各自独立的
 * KFB ActorData。用户改了本体，变体不会自动跟着变。
 *
 * 本模块提供：
 *  - findActorPair: 按命名规律识别"本体 ↔ 变体"配对
 *  - diffObjects:   结构化对比两份 semantic，输出路径级差异（叶子值不同）
 *  - setByPath:     按路径把值写回对象（用于同步目标文件）
 */
export type DiffValue = string | number | boolean | null | undefined;

export interface FieldDiff {
  /** semantic 内路径（如 ['clipsDataList', 0, 'keyframes', '5', 'boxData', 'attack_size']） */
  path: (string | number)[];
  /** 当前文件该字段的值（格式化文本） */
  aLabel: string;
  /** 配对文件该字段的值（格式化文本） */
  bLabel: string;
  /** 是否叶子标量差异（true=可同步） */
  leaf: boolean;
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return `{…}`;
  return String(v ?? '∅');
}

// KFB semantic 中具有"语义身份"的数组：每项都有能代表其身份的字段，
// 对比时不能只靠索引对齐，否则同长但内容错位的两份数组会混同步。
// key = 路径数组最后一段名（如 'clipsDataList'），value = 从元素里取身份 key 的函数。
type SemKeyFn = (el: any) => string | number | undefined;
const KFB_SEM_KEYS: Record<string, SemKeyFn> = {
  // clipsDataList[i] 是 AniClipData，用 listIndex 或 name 标识（优先 listIndex，唯一）
  clipsDataList: (el) =>
    (el && typeof el.listIndex === 'number' ? String(el.listIndex) : undefined) ??
    (el && typeof el.name === 'string' ? el.name : undefined),
  // keyframes[frameKey] 是 KFFrameData（对象键），外层 diff 走对象分支用 key 对齐，
  // 但 keyframes 元素内的 scriptDatas / keyBoxDatas 等数组需要身份键：
  scriptDatas: (el) =>
    (el && typeof el.scriptType === 'number' ? `st=${el.scriptType}` : undefined) ??
    (el && typeof el.scriptID === 'number' ? `id=${el.scriptID}` : undefined),
  keyBoxDatas: (el) =>
    (el && typeof el.boxKey === 'number' ? `boxKey=${el.boxKey}` : undefined) ??
    (el && typeof el.boxID === 'number' ? `id=${el.boxID}` : undefined),
};

/**
 * 判断当前路径末段是否是"语义可对齐"的 KFB 数组。
 * 若是，返回 keyFn；否则 undefined。
 */
function lookupSemKeyFn(prefix: (string | number)[]): SemKeyFn | undefined {
  const last = prefix[prefix.length - 1];
  if (typeof last !== 'string') return undefined;
  return KFB_SEM_KEYS[last];
}

/** diff 节点数上限：防止误把非配对文件（或超大 KFB）做 diff 导致 UI 卡死/内存爆炸 */
const DIFF_MAX_NODES = 20000;

/**
 * 递归对比两个对象，收集"叶子标量值不同"的差异。
 * 忽略 $tid（类型标记）、空对象/空数组差异、以及完全一致的子树。
 *
 * 对 KFB semantic 中具"语义身份"的数组（clipsDataList、scriptDatas、keyBoxDatas）
 * 用元素自身的标识字段（listIndex/name、scriptType、boxKey）做对齐，
 * 而非单纯按索引对齐，防止同长但内容错位的数组被伪同步。
 *
 * 遍历节点数超过 DIFF_MAX_NODES 时返回一个"已截断"的整体差异，避免 diff 爆炸。
 */
export function diffObjects(a: any, b: any, prefix: (string | number)[] = []): FieldDiff[] {
  return diffObjectsInner(a, b, prefix, { count: 0, max: DIFF_MAX_NODES });
}

interface DiffState {
  count: number;
  max: number;
}

function diffObjectsInner(
  a: any,
  b: any,
  prefix: (string | number)[],
  state: DiffState,
): FieldDiff[] {
  const out: FieldDiff[] = [];

  // 节点计数保护：超过上限，返回"已截断"整体差异
  state.count++;
  if (state.count > state.max) {
    out.push({
      path: [...prefix, '__truncated__'],
      aLabel: '…',
      bLabel: '…（差异节点数超上限，已截断）',
      leaf: false,
    });
    return out;
  }

  const isLeaf = (v: unknown) => v === null || typeof v !== 'object';
  if (isLeaf(a) || isLeaf(b)) {
    if (a === b) return out;
    const aLeaf = isLeaf(a);
    const bLeaf = isLeaf(b);
    out.push({
      path: prefix,
      aLabel: fmt(a),
      bLabel: fmt(b),
      leaf: aLeaf && bLeaf,
    });
    return out;
  }

  // ── 数组分支 ──────────────────────────────────────────────
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: prefix, aLabel: `[${a.length}]`, bLabel: `[${b.length}]`, leaf: false });
      return out;
    }

    const semKeyFn = lookupSemKeyFn(prefix);
    if (semKeyFn) {
      // ── 语义对齐：按 keyFn 结果做 Map 再匹配 ──
      const mapB = new Map<string | number, any>();
      const keyOf = (el: any) => semKeyFn(el);
      for (const el of b) {
        const k = keyOf(el);
        if (k !== undefined) mapB.set(k, el);
      }
      // 跟踪 b 中被匹配到的索引，剩余的报"仅 b 存在"
      const matchedInB = new Set<any>();
      for (const elA of a) {
        const kA = keyOf(elA);
        if (kA === undefined) {
          // 拿不到身份键：退回索引对齐（如果还有剩余元素）
          continue;
        }
        const elB = mapB.get(kA);
        const pathSeg: (string | number)[] =
          typeof kA === 'string' ? [`key:${kA}`] : [kA];
        if (elB === undefined) {
          // 仅 A 侧有该身份 → 整体报结构性差异（不可同步）
          out.push({
            path: [...prefix, ...pathSeg],
            aLabel: fmt(elA),
            bLabel: '∅（仅 A 侧存在）',
            leaf: false,
          });
        } else {
          matchedInB.add(elB);
          out.push(...diffObjectsInner(elA, elB, [...prefix, ...pathSeg], state));
        }
      }
      // b 中未匹配到的：报"仅 B 侧存在"
      for (const el of b) {
        if (matchedInB.has(el)) continue;
        const kB = keyOf(el);
        if (kB === undefined) continue;
        const pathSeg: (string | number)[] =
          typeof kB === 'string' ? [`key:${kB}`] : [kB];
        out.push({
          path: [...prefix, ...pathSeg],
          aLabel: '∅（仅 B 侧存在）',
          bLabel: fmt(el),
          leaf: false,
        });
      }
      return out;
    }

    // 非语义数组：按索引对齐
    for (let i = 0; i < a.length; i++) {
      out.push(...diffObjectsInner(a[i], b[i], [...prefix, i], state));
    }
    return out;
  }

  // ── 对象分支 ──────────────────────────────────────────────
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === '$tid') continue; // 忽略类型标记
    out.push(...diffObjectsInner(a[k], b[k], [...prefix, k], state));
  }
  return out;
}

/**
 * 从 path[0..idx] 中推导出"当前 seg 归属哪个 KFB 语义数组（如果是的话）"。
 * 规则：从 seg 往前找最近一个满足：
 *   (a) 是字符串类型，(b) 不是 key:* 前缀，(c) 名在 KFB_SEM_KEYS 中。
 * 找到即返回该名，否则 undefined。
 */
function deriveParentKeyHint(path: (string | number)[], upToExclusive: number): string | undefined {
  for (let j = upToExclusive - 1; j >= 0; j--) {
    const seg = path[j];
    if (typeof seg !== 'string') continue;
    if (seg.startsWith('key:')) continue;
    if (Object.prototype.hasOwnProperty.call(KFB_SEM_KEYS, seg)) return seg;
  }
  return undefined;
}

/**
 * 解析一个 path segment：
 *  - 普通数字或字符串 key → 直接返回（按 [] 访问）
 *  - 形如 "key:xxx" 的语义段 → 需要结合 parentKeyHint 调用 KFB_SEM_KEYS[parentKeyHint]
 *    在容器（数组）中定位元素。
 */
type ResolvedSeg =
  | { kind: 'plain'; key: string | number }
  | { kind: 'sem'; semKey: string; semVal: string };

function resolveSeg(seg: string | number, parentKeyHint: string | undefined): ResolvedSeg {
  if (typeof seg === 'number') return { kind: 'plain', key: seg };
  if (seg.startsWith('key:')) {
    return { kind: 'sem', semKey: parentKeyHint ?? guessParentFromSeg(seg.slice(4)), semVal: seg.slice(4) };
  }
  return { kind: 'plain', key: seg };
}

function guessParentFromSeg(keyVal: string): string {
  if (keyVal.startsWith('st=')) return 'scriptDatas';
  if (keyVal.startsWith('boxKey=')) return 'keyBoxDatas';
  return 'clipsDataList';
}

/**
 * 在语义数组 arr 里查找身份值 == target 的元素索引。
 */
function findSemIndex(arr: any[], semKey: string, target: string): number {
  const fn = KFB_SEM_KEYS[semKey];
  if (!fn) return -1;
  for (let i = 0; i < arr.length; i++) {
    const v = fn(arr[i]);
    if (v !== undefined && String(v) === target) return i;
  }
  return -1;
}

/** 按路径向下走一步：给定当前节点 + 当前 seg，返回子节点。找不到返回 undefined。 */
function step(cur: any, seg: string | number, parentKeyHint: string | undefined): any {
  const r = resolveSeg(seg, parentKeyHint);
  if (r.kind === 'plain') return cur[r.key];
  if (!Array.isArray(cur)) return undefined;
  const idx = findSemIndex(cur, r.semKey, r.semVal);
  return idx >= 0 ? cur[idx] : undefined;
}

/** 按路径把 value 写入 obj（路径必须存在，父级缺失则跳过）。支持语义段。 */
export function setByPath(obj: any, path: (string | number)[], value: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  let cur: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const hint = deriveParentKeyHint(path, i);
    cur = step(cur, path[i], hint);
    if (cur == null || typeof cur !== 'object') return false;
  }
  if (cur == null || typeof cur !== 'object') return false;
  const last = path[path.length - 1];
  const hint = deriveParentKeyHint(path, path.length - 1);
  const r = resolveSeg(last, hint);
  if (r.kind === 'plain') {
    cur[r.key] = value;
    return true;
  }
  if (!Array.isArray(cur)) return false;
  const idx = findSemIndex(cur, r.semKey, r.semVal);
  if (idx < 0) return false;
  cur[idx] = value;
  return true;
}

/** 按路径读取值（不存在返回 undefined）。支持语义段。 */
export function getByPath(obj: any, path: (string | number)[]): unknown {
  let cur: any = obj;
  for (let i = 0; i < path.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = step(cur, path[i], deriveParentKeyHint(path, i));
  }
  return cur;
}

/**
 * 识别"本体 ↔ P 变体"配对名。
 * 规则：90059 ↔ 90059_p。给定一个名字，返回其配对名；无法识别返回 undefined。
 */
export function findActorPair(name: string): string | undefined {
  if (!name) return undefined;
  if (/^.+_p$/.test(name)) {
    return name.slice(0, -2); // 90059_p → 90059
  }
  if (/^.+_p\d+$/.test(name)) {
    return name.replace(/_p\d+$/, ''); // 90059_p2 → 90059
  }
  // 本体 → 尝试 +_p
  return `${name}_p`;
}

/** 判断一个 KFB 名是否是"变体"（_p 或 _p2 后缀）。返回 true=变体，false=本体/未知。 */
export function isActorVariantName(name: string): boolean {
  return /_p\d*$/.test(name ?? '');
}
