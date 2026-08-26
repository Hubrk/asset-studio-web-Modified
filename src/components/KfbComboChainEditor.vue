<template>
  <div class="kfb-combo-editor" :key="'root' + renderKey">
    <div v-if="!clips.length" class="empty">连招数据为空，请先解密。</div>

    <template v-else>
      <!-- 一键操作工具栏 -->
      <section class="sec">
        <h3 class="sec-title">一键操作<span class="sec-sub">批量修改所有动作的转移点</span></h3>
        <div class="bulk-bar">
          <el-button size="small" @click="bulkClearCdCheck">去除接招CD/封印检查</el-button>
          <el-button size="small" @click="bulkEnableCdCheck">开启接招CD/封印检查</el-button>
          <span class="bulk-sep">|</span>
          <label class="bulk-label">统一段号</label>
          <el-input v-model="bulkArgStr" size="small" style="width:60px" />
          <el-button size="small" @click="bulkSetArgStr">应用</el-button>
          <span class="bulk-sep">|</span>
          <label class="bulk-label">跳转帧偏移</label>
          <el-input-number v-model="bulkJumpOffset" size="small" :controls="false" :step="1" style="width:70px" />
          <el-button size="small" @click="bulkApplyJumpOffset">应用</el-button>
        </div>
      </section>

      <!-- DAG 可视化 -->
      <section class="sec" v-if="dagNodes.length">
        <h3 class="sec-title">连招链 DAG<span class="sec-sub">点击节点查看可达路径 · 红框=无结束帧(死路) · 绿框=有接招点</span></h3>
        <div class="dag-info-bar">
          <span>节点 {{ dagNodes.length }}</span>
          <span>边 {{ dagEdges.length }}</span>
          <span class="dag-legend"><span class="lg-line accept"></span>接招(1007)</span>
          <span class="dag-legend"><span class="lg-line jump"></span>跳转(1031)</span>
          <span class="dag-dead" v-if="deadEnds.length">死路 {{ deadEnds.length }}: {{ deadEnds.map(d => d.name).join(', ') }}</span>
          <span v-if="selectedNode" class="dag-sel">已选: {{ selectedNode }} → 可达 {{ reachable.size - 1 }} 个节点</span>
          <el-button v-if="selectedNode" size="small" text @click="selectedNode = null">取消选择</el-button>
        </div>
        <div class="dag-scroll">
          <svg :width="dagWidth" :height="dagHeight" class="dag-svg">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="rgba(255,255,255,0.4)" />
              </marker>
              <marker id="arrow-jump" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="#e6a23c" />
              </marker>
              <marker id="arrow-hi" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="var(--el-color-primary)" />
              </marker>
            </defs>
            <!-- 边 -->
            <g v-for="(e, i) in dagEdges" :key="'e' + i">
              <path
                :d="edgePath(e)"
                :class="['dag-edge', e.kind, edgeState(e)]"
                :marker-end="edgeState(e) === 'highlight' ? 'url(#arrow-hi)' : e.kind === 'jump' ? 'url(#arrow-jump)' : 'url(#arrow)'"
              />
              <title>{{ e.from }} → {{ e.to }}（{{ e.label }}）</title>
            </g>
            <!-- 节点 -->
            <g
              v-for="n in dagNodes"
              :key="'n' + n.name"
              :class="['dag-node-g', nodeState(n.name)]"
              @click="selectNode(n.name)"
            >
              <rect
                :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="6"
                :class="['dag-node-rect', { dead: n.isDead, accept: n.hasAccept }]"
              />
              <text :x="n.x + n.w / 2" :y="n.y + 16" text-anchor="middle" class="dag-node-text">{{ n.name }}</text>
              <text :x="n.x + n.w / 2" :y="n.y + 29" text-anchor="middle" class="dag-node-meta">{{ n.transferCount }}转移点</text>
            </g>
          </svg>
        </div>
      </section>

      <!-- 连招链总览 -->
      <section class="sec" v-if="basicChain.length">
        <h3 class="sec-title">普攻连招链<span class="sec-sub">按段号 argStr 串联，播放到带「接招」标记的帧时再次按键进入下一段</span></h3>
        <div class="chain">
          <template v-for="(c, i) in basicChain" :key="'chain' + i">
            <div class="chain-node">
              <div class="chain-name">{{ c.name }}</div>
              <div class="chain-meta">{{ c.totalframes }}帧{{ c.loop ? ' · 循环' : '' }}</div>
            </div>
            <div v-if="i < basicChain.length - 1" class="chain-arrow">➜</div>
          </template>
        </div>
      </section>

      <!-- 全部动作的转移点 -->
      <section class="sec">
        <h3 class="sec-title">动作转移点<span class="sec-sub">每个动作内可衔接下一段的帧</span></h3>
        <div class="clip-cards">
          <div v-for="c in shownClips" :key="'clip' + c.name" class="clip-card">
            <div class="clip-head">
              <span class="clip-name">{{ c.name }}</span>
              <span class="clip-meta">{{ c.totalframes }}帧{{ c.loop ? ' · 循环' : '' }}</span>
            </div>
            <div v-if="!c.transfers.length" class="no-transfer">无转移点</div>
            <div v-else class="transfer-list">
              <div v-for="(t, i) in c.transfers" :key="c.name + '_t' + i" class="transfer">
                <span class="t-frame">帧{{ t.frame }}</span>
                <span class="t-badge" :class="'badge-' + t.type">
                  {{ t.type === 'accept-vkey' ? '接招' : t.type === 'jump' ? '跳转' : '结束' }}
                </span>

                <!-- 接招：可编辑段号 argStr -->
                <template v-if="t.type === 'accept-vkey'">
                  <label class="t-label">段号</label>
                  <el-input-number v-model="t.ref.argStr" size="small" :controls="false" :min="0" @change="onAnyChange" />
                  <span class="t-vkeys" :title="'按键值：' + t.vkeys.join(', ')">按键[{{ t.vkeys.join(',') }}]</span>
                  <span class="t-cd" v-if="t.ref.checkIsInCD">CD✓</span>
                  <span class="t-cd" v-if="t.ref.checkIsSealed">封印✓</span>
                </template>

                <!-- 跳转：可编辑目标帧 argInt -->
                <template v-else-if="t.type === 'jump'">
                  <label class="t-label">目标帧</label>
                  <el-input-number v-model="t.ref.argInt" size="small" :controls="false" @change="onAnyChange" />
                </template>

                <span v-else class="t-end-note">到此结束</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { buildComboChain, type ComboClip } from '@/workers/assetManager/kfb/kfbSkillModel';

const props = defineProps<{ sem: any }>();
const emit = defineEmits<{ (e: 'change'): void }>();

const clips = ref<ComboClip[]>([]);
const selectedNode = ref<string | null>(null);
const renderKey = ref(0);

function rebuild() {
  clips.value = props.sem ? buildComboChain(props.sem) : [];
  selectedNode.value = null;
}

watch(
  () => props.sem,
  () => rebuild(),
  { immediate: true },
);

/** 普攻连招链 */
const basicChain = computed(() => {
  return clips.value
    .filter((c) => /^attack\d+/i.test(c.name))
    .sort((a, b) => {
      const na = Number(a.name.replace(/^attack/i, ''));
      const nb = Number(b.name.replace(/^attack/i, ''));
      return na - nb;
    })
    .slice(0, 12);
});

/** 展示的动作卡片 */
const shownClips = computed(() => {
  const prio = (n: string): number => {
    if (/^skill/i.test(n)) return 0;
    if (/^attack\d+/i.test(n)) return 1;
    if (/^(idle|move|run|get_hit|catch|float|lie_down|lie_got_up|Jump_in|Jump_out)$/i.test(n)) return 3;
    return 2;
  };
  return [...clips.value].sort((a, b) => prio(a.name) - prio(b.name) || a.name.localeCompare(b.name));
});

function onAnyChange() {
  emit('change');
}

// ─────────────── DAG 可视化 ───────────────

interface DagNode {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hasEnd: boolean;
  hasAccept: boolean;
  isDead: boolean;
  transferCount: number;
}

interface DagEdge {
  from: string;
  to: string;
  frame: string;
  label: string;
  kind: 'accept' | 'jump';
}

const NODE_W = 116;
const NODE_H = 38;
const GAP_X = 22;
const GAP_Y = 68;
const PAD = 20;
const MAX_PER_ROW = 10;

/** 推断接招点的目标 clip（基于命名约定） */
function inferTarget(clipName: string, argStr: string, allNames: Set<string>): string | null {
  const m = clipName.match(/^attack(\d+)$/i);
  if (m) {
    const n = parseInt(m[1]);
    const next = `attack${n + 1}`;
    if (allNames.has(next)) return next;
  }
  if (/^\d+$/.test(argStr)) {
    const s = parseInt(argStr);
    const t1 = `attack${s}`;
    if (allNames.has(t1)) return t1;
    const t2 = `attack${s + 1}`;
    if (allNames.has(t2)) return t2;
  }
  return null;
}

/** 推断 1031 跳转的目标 clip（基于命名约定和段号） */
function inferJumpTarget(clipName: string, argInt: number, allNames: Set<string>): string | null {
  // 系统级跳转（9997/9998/1059902 等）不是 clip 间跳转
  if (argInt >= 9990) return null;

  // 尝试匹配同系列下一段 clip
  // skill_A_1 → skill_A_2, skill_C_1 → skill_C_2, Ultra_kill_1 → Ultra_kill_2
  const m = clipName.match(/^(.+?)(\d+)$/);
  if (m) {
    const prefix = m[1];
    const n = parseInt(m[2]);
    const next = `${prefix}${n + 1}`;
    if (allNames.has(next)) return next;
  }
  return null;
}

const allClipNames = computed(() => new Set(clips.value.map((c) => c.name)));

const dagNodes = computed<DagNode[]>(() => {
  const names = clips.value.map((c) => c.name);
  const attackNodes = names
    .filter((n) => /^attack\d+/i.test(n))
    .sort((a, b) => parseInt(a.replace(/^attack/i, '')) - parseInt(b.replace(/^attack/i, '')));
  const skillNodes = names.filter((n) => /^skill/i.test(n)).sort();
  const otherNodes = names
    .filter((n) => !/^attack\d+/i.test(n) && !/^skill/i.test(n))
    .sort();

  const nodes: DagNode[] = [];
  let row = 0;

  const placeRow = (rowNames: string[]) => {
    for (let i = 0; i < rowNames.length; i++) {
      const r = Math.floor(i / MAX_PER_ROW);
      const c = i % MAX_PER_ROW;
      const clip = clips.value.find((cl) => cl.name === rowNames[i]);
      const hasEnd = clip?.transfers.some((t) => t.type === 'end-frame') ?? false;
      const hasAccept = clip?.transfers.some((t) => t.type === 'accept-vkey') ?? false;
      nodes.push({
        name: rowNames[i],
        x: PAD + c * (NODE_W + GAP_X),
        y: PAD + (row + r) * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H,
        hasEnd,
        hasAccept,
        isDead: !hasEnd,
        transferCount: clip?.transfers.length ?? 0,
      });
    }
    row += Math.ceil(rowNames.length / MAX_PER_ROW) + 1;
  };

  if (attackNodes.length) placeRow(attackNodes);
  if (skillNodes.length) placeRow(skillNodes);
  if (otherNodes.length) placeRow(otherNodes);
  return nodes;
});

const dagEdges = computed<DagEdge[]>(() => {
  const edges: DagEdge[] = [];
  const names = allClipNames.value;
  for (const c of clips.value) {
    for (const t of c.transfers) {
      if (t.type === 'accept-vkey') {
        const target = inferTarget(c.name, t.argStr, names);
        if (target) {
          edges.push({
            from: c.name,
            to: target,
            frame: t.frame,
            label: `帧${t.frame}·段${t.argStr}`,
            kind: 'accept',
          });
        }
      } else if (t.type === 'jump') {
        const target = inferJumpTarget(c.name, t.argInt, names);
        if (target) {
          edges.push({
            from: c.name,
            to: target,
            frame: t.frame,
            label: `帧${t.frame}·跳${t.argInt}`,
            kind: 'jump',
          });
        }
      }
    }
  }
  return edges;
});

const dagWidth = computed(() => {
  const max = dagNodes.value.reduce((m, n) => Math.max(m, n.x + n.w), 0);
  return max + PAD;
});

const dagHeight = computed(() => {
  const max = dagNodes.value.reduce((m, n) => Math.max(m, n.y + n.h), 0);
  return max + PAD;
});

// 高亮：点击节点 → BFS 找可达节点
const reachable = computed<Set<string>>(() => {
  if (!selectedNode.value) return new Set();
  const result = new Set<string>([selectedNode.value]);
  const queue = [selectedNode.value];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of dagEdges.value) {
      if (e.from === cur && !result.has(e.to)) {
        result.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return result;
});

function selectNode(name: string) {
  selectedNode.value = selectedNode.value === name ? null : name;
}

function nodeState(name: string): 'selected' | 'reachable' | 'dim' | 'normal' {
  if (!selectedNode.value) return 'normal';
  if (selectedNode.value === name) return 'selected';
  if (reachable.value.has(name)) return 'reachable';
  return 'dim';
}

function edgeState(e: DagEdge): 'highlight' | 'dim' | 'normal' {
  if (!selectedNode.value) return 'normal';
  if (reachable.value.has(e.from) && reachable.value.has(e.to)) return 'highlight';
  return 'dim';
}

function edgePath(e: DagEdge): string {
  const from = dagNodes.value.find((n) => n.name === e.from);
  const to = dagNodes.value.find((n) => n.name === e.to);
  if (!from || !to) return '';
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

// 死路检测
const deadEnds = computed(() =>
  clips.value.filter((c) => !c.transfers.some((t) => t.type === 'end-frame')),
);

// ─────────────── 一键操作 ───────────────

function forceRefresh() {
  renderKey.value++;
}

/** 一键去除所有接招点的 CD/封印检查 */
function bulkClearCdCheck() {
  for (const c of clips.value)
    for (const t of c.transfers)
      if (t.type === 'accept-vkey' && t.ref) {
        t.ref.checkIsInCD = false;
        t.ref.checkIsSealed = false;
      }
  forceRefresh();
  emit('change');
}

/** 一键开启所有接招点的 CD/封印检查 */
function bulkEnableCdCheck() {
  for (const c of clips.value)
    for (const t of c.transfers)
      if (t.type === 'accept-vkey' && t.ref) {
        t.ref.checkIsInCD = true;
        t.ref.checkIsSealed = true;
      }
  forceRefresh();
  emit('change');
}

/** 一键把所有接招段号统一设为指定值 */
const bulkArgStr = ref('1');
function bulkSetArgStr() {
  for (const c of clips.value)
    for (const t of c.transfers)
      if (t.type === 'accept-vkey' && t.ref) {
        t.ref.argStr = bulkArgStr.value;
        t.argStr = bulkArgStr.value;
      }
  forceRefresh();
  emit('change');
}

/** 一键把所有跳转目标帧统一偏移 */
const bulkJumpOffset = ref(0);
function bulkApplyJumpOffset() {
  const off = bulkJumpOffset.value;
  if (!off) return;
  for (const c of clips.value)
    for (const t of c.transfers)
      if (t.type === 'jump' && t.ref) {
        const nv = (t.ref.argInt ?? 0) + off;
        t.ref.argInt = nv;
        t.argInt = nv;
      }
  forceRefresh();
  emit('change');
}
</script>

<style scoped>
.kfb-combo-editor {
  height: 100%;
  overflow: auto;
  padding: 4px 2px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.empty {
  color: rgba(255, 255, 255, 0.5);
  padding: 40px;
  text-align: center;
}
.sec-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sec-sub {
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
}
.chain {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.chain-node {
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.04);
  text-align: center;
}
.chain-name {
  font-weight: 600;
  font-size: 13px;
}
.chain-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}
.chain-arrow {
  font-size: 18px;
  color: var(--el-color-primary);
}
.clip-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.clip-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
}
.clip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.clip-name {
  font-weight: 600;
  font-size: 13px;
}
.clip-meta {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}
.no-transfer {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
}
.transfer-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.transfer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
.t-frame {
  font-family: Consolas, Monaco, monospace;
  color: rgba(255, 255, 255, 0.6);
  min-width: 44px;
}
.t-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  color: #fff;
}
.badge-accept-vkey {
  background: #67c23a;
}
.badge-jump {
  background: #e6a23c;
}
.badge-end-frame {
  background: #909399;
}
.t-label {
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
}
.t-vkeys {
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}
.t-end-note {
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
}
.t-cd {
  font-size: 10px;
  color: #e6a23c;
  padding: 0 4px;
  border: 1px solid rgba(230, 162, 60, 0.3);
  border-radius: 3px;
}

/* ===== 一键操作工具栏 ===== */
.bulk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.bulk-sep {
  color: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
}
.bulk-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
}

/* ===== DAG 可视化 ===== */
.dag-info-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.dag-dead {
  color: #f56c6c;
  font-weight: 600;
}
.dag-sel {
  color: var(--el-color-primary);
  font-weight: 600;
}
.dag-scroll {
  overflow: auto;
  max-height: 420px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.15);
}
.dag-svg {
  display: block;
}
.dag-edge {
  fill: none;
  stroke: rgba(255, 255, 255, 0.2);
  stroke-width: 1.5;
  transition: all 0.2s;
}
.dag-edge.accept {
  stroke: rgba(103, 194, 58, 0.5);
}
.dag-edge.jump {
  stroke: rgba(230, 162, 60, 0.5);
  stroke-dasharray: 5 3;
}
.dag-edge.highlight {
  stroke: var(--el-color-primary);
  stroke-width: 2.5;
  stroke-dasharray: none;
}
.dag-edge.dim {
  stroke: rgba(255, 255, 255, 0.06);
  stroke-dasharray: none;
}
.dag-legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}
.lg-line {
  display: inline-block;
  width: 20px;
  height: 0;
  border-top: 2px solid rgba(255, 255, 255, 0.2);
}
.lg-line.accept {
  border-color: rgba(103, 194, 58, 0.6);
}
.lg-line.jump {
  border-color: rgba(230, 162, 60, 0.6);
  border-style: dashed;
}
.dag-node-g {
  cursor: pointer;
}
.dag-node-rect {
  fill: rgba(255, 255, 255, 0.06);
  stroke: rgba(255, 255, 255, 0.2);
  stroke-width: 1.5;
  transition: all 0.2s;
}
.dag-node-rect.dead {
  stroke: #f56c6c;
  stroke-width: 2;
}
.dag-node-rect.accept {
  stroke: #67c23a;
}
.dag-node-g:hover .dag-node-rect {
  fill: rgba(255, 255, 255, 0.12);
}
.dag-node-g.selected .dag-node-rect {
  fill: var(--el-color-primary);
  stroke: var(--el-color-primary);
  stroke-width: 2.5;
}
.dag-node-g.selected .dag-node-text {
  fill: #fff;
  font-weight: 700;
}
.dag-node-g.reachable .dag-node-rect {
  fill: rgba(103, 194, 58, 0.15);
  stroke: #67c23a;
}
.dag-node-g.dim {
  opacity: 0.3;
}
.dag-node-text {
  font-size: 11px;
  fill: rgba(255, 255, 255, 0.8);
  font-family: Consolas, Monaco, monospace;
  pointer-events: none;
  user-select: none;
}
.dag-node-meta {
  font-size: 9px;
  fill: rgba(255, 255, 255, 0.4);
  pointer-events: none;
  user-select: none;
}
</style>