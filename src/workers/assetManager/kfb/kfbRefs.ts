/**
 * KFB 跨文件引用提取与校验
 * -------------------------
 * 从 KFB ActorData 的 semantic JSON 中提取三类跨文件引用：
 *  - interact: KH.CreateInteractArg (scriptType=10001) 的 assetId → 召唤同 bundle 的其他 KFB TextAsset
 *  - jump:     scriptType=1044 的 argStr → 跨包脚本切换（形如 _script_90059403b）
 *  - global:   scriptType=1031 的 argInt → 全局帧引用（本包 ObjectFrames 或外部资源）
 *
 * 遍历方式与 kfbSkillModel.ts 一致：objectFrames + clipsDataList 两处都扫。
 */
export type RefKind = 'interact' | 'jump' | 'global';

export interface KfbReference {
  kind: RefKind;
  scriptType: number;
  /** 引用目标名（assetId 原值 / argStr 提取的数字名 / argInt 转字符串） */
  target: string;
  /** semantic 内的定位路径（供 UI 显示来源） */
  sourcePath: string[];
}

/**
 * 从 1044 的 argStr 中提取目标 KFB 名。
 * argStr 形如 "_script_90059403b" / "_scriptnotnull_90059802b"，
 * 提取其中的数字段（去掉尾部字母后缀如 b）。
 *
 * 只处理带 "_script(notnull)_" 前缀的跨包脚本切换标记，避免把
 * self_rune / _self_psychic 这类特殊标记误判为文件引用。
 * 取最后一个 4 位以上数字段（真实目标名通常在 argStr 结尾）。
 */
export function extractTargetFromArgStr(argStr: string): string {
  if (!argStr) return '';
  // 仅识别跨包脚本切换标记（带 _script 前缀），其余特殊标记一律视为非文件引用
  if (!/_script(?:notnull)?_/.test(argStr)) return '';
  const matches = argStr.match(/(\d{4,})/g);
  if (!matches) return '';
  return matches[matches.length - 1];
}

/**
 * 从 semantic JSON 提取所有跨文件引用。
 * 遍历 objectFrames 和 clipsDataList 中的所有 scriptDatas。
 */
export function extractKfbRefs(sem: any): KfbReference[] {
  const refs: KfbReference[] = [];
  if (!sem || typeof sem !== 'object') return refs;

  const collectFromFrameData = (fd: any, path: string[]) => {
    if (!fd || !Array.isArray(fd.scriptDatas)) return;
    for (const s of fd.scriptDatas) {
      if (!s || typeof s.scriptType !== 'number') continue;
      if (s.scriptType === 10001) {
        // CreateInteractArg: assetId 是目标 KFB 名
        const assetId = String(s.assetId ?? '').trim();
        if (assetId) {
          refs.push({ kind: 'interact', scriptType: 10001, target: assetId, sourcePath: [...path, `scriptType=10001`] });
        }
      } else if (s.scriptType === 1044) {
        // 跨包脚本切换: argStr 含目标包名
        const argStr = String(s.argStr ?? '').trim();
        const target = extractTargetFromArgStr(argStr);
        if (target) {
          refs.push({ kind: 'jump', scriptType: 1044, target, sourcePath: [...path, `scriptType=1044 argStr=${argStr}`] });
        }
      } else if (s.scriptType === 1031) {
        // 全局帧引用: argInt 是目标帧/资源 ID
        const argInt = Number(s.argInt ?? 0);
        // 仅收集 4 位以上的 ID（短的 argInt 可能只是普通帧跳转，非跨文件引用）
        if (argInt >= 1000) {
          refs.push({ kind: 'global', scriptType: 1031, target: String(argInt), sourcePath: [...path, `scriptType=1031 argInt=${argInt}`] });
        }
      }
    }
  };

  // 1. objectFrames
  const of = sem.objectFrames;
  if (of && typeof of === 'object') {
    for (const key of Object.keys(of)) {
      const frame = of[key];
      const fd = frame?.frameData;
      if (fd) collectFromFrameData(fd, ['objectFrames', key]);
    }
  }

  // 2. clipsDataList
  const clips = sem.clipsDataList;
  if (Array.isArray(clips)) {
    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci];
      const clipName = clip?.name ?? `clip[${ci}]`;
      const kf = clip?.keyframes;
      if (kf && typeof kf === 'object') {
        for (const frameKey of Object.keys(kf)) {
          const fd = kf[frameKey]?.frameData;
          if (fd) collectFromFrameData(fd, ['clips', clipName, `frame=${frameKey}`]);
        }
      }
    }
  }

  return refs;
}

/**
 * 校验引用目标是否存在于同 bundle 的 KFB TextAsset 名集合中。
 * - interact / jump: 检查 target 是否在 availableNames 中（严格匹配）
 * - global: 标记为外部引用（不拦截，仅提示）
 *
 * @returns broken: 目标不存在的引用列表（仅 interact / jump）
 */
export function validateRefs(
  refs: KfbReference[],
  availableNames: string[],
): { ok: boolean; broken: KfbReference[] } {
  const nameSet = new Set(availableNames);
  const broken: KfbReference[] = [];
  for (const r of refs) {
    if (r.kind === 'global') continue; // 全局帧引用不拦截
    if (!nameSet.has(r.target)) {
      broken.push(r);
    }
  }
  return { ok: broken.length === 0, broken };
}

// ─────────────── 技能链可视化 ───────────────

export interface ChainNode {
  /** 资产名（assetId），如 90059401 */
  name: string;
  /** 该节点是否在所有已加载 KFB 资产中存在 */
  exists: boolean;
  /** 它召唤的目标（下一层链） */
  children: ChainNode[];
  /** 是否已展开（children 是否已填充） */
  loaded: boolean;
}

/**
 * 在链树上按名查找节点（BFS），用于防环与懒加载命中。
 */
export function findChainNode(root: ChainNode, name: string): ChainNode | null {
  const stack: ChainNode[] = [root];
  const visited = new Set<ChainNode>();
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n)) continue;
    visited.add(n);
    if (n.name === name) return n;
    stack.push(...n.children);
  }
  return null;
}

/**
 * 把一条引用记录整理成可显示的链边信息（纯函数，供 UI 渲染）。
 */
export function chainEdgeLabel(r: KfbReference): string {
  switch (r.kind) {
    case 'interact':
      return `召唤 ${r.target}`;
    case 'jump':
      return `跨包 ${r.target}`;
    case 'global':
      return `全局帧 ${r.target}`;
    default:
      return r.target;
  }
}

