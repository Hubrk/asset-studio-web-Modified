/**
 * 帧动画分组（纯函数，可被 worker loader 与测试共用）
 *
 * 依据 Sprite 命名解析动画组：
 *   `<动画组名>_<帧号>`                → 如 "attack_1_1nrtcmb00_0000"
 *   `<动画组名>_<帧号>_<分块字母>`      → 如 "idle_0knn1_0000_A"（多图块合帧）
 *
 * 复合帧（多分块）：
 *   同一帧号下的所有分块（主块 + _A/_B/_C…）合成为「一帧」。
 *   各分块以其 Sprite.pivot 点为共同锚点（pivot 对齐，pivot 是相对 rect
 *   的归一化坐标，可超出 [0,1]），拼出该时刻的完整画面（与游戏渲染一致）。
 */
import type { FrameAnimationFrame, FrameAnimationGroup, FrameTileOffset } from '@/types/preview';

// 帧名：`<组名>_<帧号>[_分块字母]`，分块字母前的 `_` 可选（兼容 `_0009B` 与 `_0000_A`）
const FRAME_RE = /^(.*)_(\d{2,4})_?([A-Za-z]\d*)?$/;

/** 复合帧预览 payload 前缀：worker 收到该前缀时按复合布局渲染整帧 */
export const COMPOSITE_PREFIX = '__composite__';

export interface FrameAnimSpriteInput {
  pathId: bigint | string;
  name: string;
  rect: { x: number; y: number; w: number; h: number };
  /** Sprite.pivot（归一化），缺省按中心 (0.5, 0.5) */
  pivot?: { x: number; y: number };
}

/** 复合帧 payload（tiles 已在画布坐标系内，px/py 均为 >=0 整数） */
export interface CompositePayload {
  w: number;
  h: number;
  tiles: FrameTileOffset[];
}

/** 去掉命名尾部的帧号/分块后缀，得到动画组名（无帧号则原样返回） */
export const stripFrameSuffix = (name: string): string => {
  const m = FRAME_RE.exec(name || '');
  return m ? m[1] : name;
};

/** 解析帧名 → 组名 + 帧号 + 分块；不是帧名（无数字结尾）返回 null */
export const parseFrameName = (
  name: string,
): { group: string; frame: number; tile: string } | null => {
  const m = FRAME_RE.exec(name || '');
  if (!m) return null;
  return { group: m[1], frame: Number(m[2]), tile: m[3] ?? '' };
};

/** 构造复合帧 payload 字符串（worker 端按此渲染整帧） */
export const buildCompositePayload = (c: CompositePayload): string =>
  COMPOSITE_PREFIX +
  JSON.stringify({
    v: 1,
    w: c.w,
    h: c.h,
    t: c.tiles.map(t => [t.key, t.name ?? '', t.px, t.py, t.w, t.h]),
  });

/** 解析复合帧 payload；非复合帧返回 null */
export const parseCompositePayload = (s: string): CompositePayload | null => {
  if (!s.startsWith(COMPOSITE_PREFIX)) return null;
  try {
    const o = JSON.parse(s.slice(COMPOSITE_PREFIX.length));
    const tiles: FrameTileOffset[] = (o.t as any[]).map((tt: any) => ({
      key: String(tt[0]),
      name: String(tt[1] ?? ''),
      px: tt[2] as number,
      py: tt[3] as number,
      w: tt[4] as number,
      h: tt[5] as number,
    }));
    return { w: o.w as number, h: o.h as number, tiles };
  } catch {
    return null;
  }
};

/**
 * 按动画组构建帧列表（仅返回 >=2 帧的组，组名升序；组内按帧号升序）。
 * 传入的 sprites 应为「同图集」的全部 Sprite；无动画组时返回空数组。
 *
 * 每帧 = 同一帧号下的全部分块，按 pivot 对齐合成（多分块帧）或单块直通。
 */
export const buildFrameGroups = (sprites: FrameAnimSpriteInput[]): FrameAnimationGroup[] => {
  // group → frameNo → pieces
  const byGroup = new Map<string, Map<number, FrameAnimSpriteInput[]>>();
  for (const s of sprites) {
    const parsed = parseFrameName(s.name || '');
    if (!parsed) continue; // 图标等无帧号的 Sprite 不进动画组
    let m = byGroup.get(parsed.group);
    if (!m) {
      m = new Map();
      byGroup.set(parsed.group, m);
    }
    let arr = m.get(parsed.frame);
    if (!arr) {
      arr = [];
      m.set(parsed.frame, arr);
    }
    arr.push(s);
  }

  const groups: FrameAnimationGroup[] = [];
  for (const [groupName, m] of byGroup) {
    const frames: FrameAnimationFrame[] = [];
    for (const idx of [...m.keys()].sort((a, b) => a - b)) {
      const f = buildCompositeFrame(m.get(idx)!);
      if (f) frames.push(f);
    }
    if (frames.length >= 2) {
      groups.push({ name: groupName, frameCount: frames.length, frames });
    }
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
};

/** 同帧号分块 → 一帧（pivot 对齐合成布局） */
const buildCompositeFrame = (pieces: FrameAnimSpriteInput[]): FrameAnimationFrame | null => {
  if (!pieces.length) return null;
  const main = pieces.find(p => !parseFrameName(p.name!)?.tile) ?? pieces[0];

  // 单块：直通旧逻辑（key=pathId，worker 按单帧切片渲染）
  if (pieces.length === 1) {
    const p = pieces[0];
    return {
      key: String(p.pathId),
      name: p.name,
      rect: { x: p.rect.x, y: p.rect.y, w: p.rect.w, h: p.rect.h },
    };
  }

  // 多块：pivot 对齐 —— 每块的 pivot 像素点落在画布同一点，画布原点 = 各块
  // pivot 的最左上点。块在画布上的位置与图集 rect 无关，仅由 pivot 决定：
  //   topLeft = (-pivot.x * w, -pivot.y * h) - (minX, minY)
  const pivotOf = (p: FrameAnimSpriteInput) => p.pivot ?? { x: 0.5, y: 0.5 };
  const placed = pieces.map(p => {
    const piv = pivotOf(p);
    return { p, x: -piv.x * p.rect.w, y: -piv.y * p.rect.h };
  });
  const minX = Math.min(...placed.map(t => t.x));
  const minY = Math.min(...placed.map(t => t.y));

  const tiles: FrameTileOffset[] = placed.map(t => ({
    key: String(t.p.pathId),
    name: t.p.name,
    px: Math.round(t.x - minX),
    py: Math.round(t.y - minY),
    w: Math.max(1, Math.round(t.p.rect.w)),
    h: Math.max(1, Math.round(t.p.rect.h)),
  }));
  const canvasW = Math.max(...tiles.map(t => t.px + t.w));
  const canvasH = Math.max(...tiles.map(t => t.py + t.h));

  return {
    key: buildCompositePayload({ w: canvasW, h: canvasH, tiles }),
    name: main.name,
    rect: { x: main.rect.x, y: main.rect.y, w: main.rect.w, h: main.rect.h },
    canvasW,
    canvasH,
    tiles,
  };
};