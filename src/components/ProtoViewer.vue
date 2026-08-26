<template>
  <div class="proto-viewer">
    <div class="toolbar">
      <span class="asset-name" :title="info?.name">{{ info?.name }}</span>
      <el-divider direction="vertical" />
      <span v-if="nodes.length" class="meta">{{ nodeCount }} 字段 · {{ dataLen }} B<template v-if="dirty"> → <b class="new-len">{{ newLen }} B</b></template></span>
      <div class="spacer" />
      <el-button size="small" @click="expandAll">全部展开</el-button>
      <el-button size="small" @click="collapseAll">全部折叠</el-button>
      <el-divider direction="vertical" />
      <el-button size="small" @click="exportJson">导出 JSON</el-button>
      <el-button size="small" @click="exportText">导出文本</el-button>
      <el-button size="small" @click="exportRaw">导出 .bytes</el-button>
      <el-divider direction="vertical" />
      <el-button size="small" type="primary" :disabled="!dirty || saving" :loading="saving" @click="save">
        保存回写
      </el-button>
    </div>

    <div v-if="loading" class="proto-loading">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>解码中…</span>
    </div>

    <div v-else-if="error" class="proto-error">
      <el-icon><Warning /></el-icon>
      <span>{{ error }}</span>
    </div>

    <div v-else class="proto-body">
      <div class="proto-hex">
        <span class="hex-title">头部字节</span>
        <code>{{ headHex }}</code>
        <span v-if="dirty" class="hex-dirty">（已修改，保存后生效）</span>
      </div>
      <div class="proto-tree">
        <ProtoNodeView
          v-for="(n, i) in nodes"
          :key="i"
          :node="n"
          :depth="0"
          :default-open="openAll"
          :expand-all-tick="expandTick"
          :on-edit="openEdit"
        />
      </div>
    </div>

    <el-dialog v-model="editVisible" title="编辑字段值" width="480px" append-to-body :close-on-click-modal="false">
      <div v-if="editing" class="edit-head">
        <span class="edit-path">[{{ editing.field }}]</span>
        <span :class="['proto-kind', kindClass(editing.kind)]">{{ editing.kind }}</span>
        <span v-if="editing.semantic" class="edit-semantic">{{ editing.semantic }}</span>
        <span v-if="editing.strong" class="edit-strong">强影响</span>
      </div>
      <el-input
        v-model="editInput"
        :placeholder="editPlaceholder"
        class="edit-input"
        @keyup.enter="confirmEdit"
      />
      <div v-if="editError" class="edit-error">{{ editError }}</div>
      <template #footer>
        <el-button size="small" @click="editVisible = false">取消</el-button>
        <el-button size="small" type="primary" @click="confirmEdit">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineComponent, h, watch, onMounted } from 'vue';
import type { PropType } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Warning, EditPen } from '@element-plus/icons-vue';
import { useAssetManager } from '@/store/assetManager';
import {
  decodeProtoMessage,
  annotateProtoTree,
  encodeProtoMessage,
  editNodeValue,
  protoTreeToText,
  protoTreeToJson,
  type ProtoNode,
} from '@/utils/protoDecode';

const store = useAssetManager();
const info = computed(() => store.curAssetInfo);

const loading = ref(true);
const error = ref('');
const nodes = ref<ProtoNode[]>([]);
const raw = ref<Uint8Array | null>(null);
const openAll = ref(true);
const expandTick = ref(0);
const dirty = ref(false);
const saving = ref(false);

const editVisible = ref(false);
const editing = ref<ProtoNode | null>(null);
const editInput = ref('');
const editError = ref('');

const dataLen = computed(() => raw.value?.length ?? 0);
const newLen = computed(() => (dirty.value ? encodeProtoMessage(nodes.value).length : dataLen.value));
const headHex = computed(() =>
  raw.value
    ? Array.from(raw.value.subarray(0, 16))
        .map(x => x.toString(16).padStart(2, '0'))
        .join(' ')
    : '',
);

const nodeCount = computed(() => {
  let n = 0;
  const walk = (list: ProtoNode[]) => {
    for (const x of list) {
      n++;
      if (x.children) walk(x.children);
    }
  };
  walk(nodes.value);
  return n;
});

const KIND_CLASS: Record<string, string> = {
  varint: 'kind-varint',
  fixed32: 'kind-fixed',
  fixed64: 'kind-fixed',
  string: 'kind-string',
  bytes: 'kind-bytes',
  message: 'kind-message',
};

// ── 递归树节点渲染组件（自引用实现递归） ──
const ProtoNodeView = defineComponent({
  name: 'ProtoNodeView',
  props: {
    node: { type: Object as PropType<ProtoNode>, required: true },
    depth: { type: Number, default: 0 },
    defaultOpen: { type: Boolean, default: true },
    expandAllTick: { type: Number, default: 0 },
    onEdit: { type: Function as PropType<(n: ProtoNode) => void>, default: null },
  },
  setup(props) {
    const open = ref(props.defaultOpen);
    watch(
      () => props.expandAllTick,
      () => {
        open.value = props.defaultOpen;
      },
    );
    watch(
      () => props.defaultOpen,
      v => {
        open.value = v;
      },
    );

    return (): any => {
      const n = props.node;
      const isMsg = n.kind === 'message';
      const pad = { paddingLeft: `${props.depth * 16 + 8}px` };
      const semanticBadge =
        n.semantic || n.strong
          ? h('span', { class: ['sem-badge', n.strong ? 'sem-strong' : ''] }, [n.strong ? '★ 强影响' : '', n.semantic ? ` ${n.semantic}` : ''].join(''))
          : null;
      const editBtn =
        !isMsg && props.onEdit
          ? h('span', { class: 'proto-edit', title: '编辑值', onClick: (e: MouseEvent) => { e.stopPropagation(); props.onEdit?.(n); } }, h(EditPen))
          : null;
      return h('div', { class: ['proto-row', isMsg ? 'proto-row-msg' : ''], style: pad }, [
        isMsg
          ? h('span', { class: 'proto-toggle', onClick: () => (open.value = !open.value) }, open.value ? '▾' : '▸')
          : h('span', { class: 'proto-toggle proto-toggle-empty' }, ''),
        h('span', { class: 'proto-field' }, `[${n.field}]`),
        h('span', { class: ['proto-kind', KIND_CLASS[n.kind] ?? ''] }, n.kind),
        semanticBadge,
        isMsg
          ? h(
              'span',
              { class: 'proto-msg-label', onClick: () => (open.value = !open.value) },
              `${n.value}${open.value ? '' : ` (${(n.children ?? []).length} 字段)`}`,
            )
          : h('span', { class: 'proto-value', onClick: () => props.onEdit?.(n) }, n.value),
        editBtn,
        isMsg && open.value
          ? h(
              'div',
              { class: 'proto-children' },
              (n.children ?? []).map((c): any =>
                h(ProtoNodeView, { node: c, depth: props.depth + 1, defaultOpen: props.defaultOpen, expandAllTick: props.expandAllTick, onEdit: props.onEdit }),
              ),
            )
          : null,
      ]);
    };
  },
});
// 递归自引用：避免 TS 对 defineComponent 的循环类型推断，显式标注为 any
void (ProtoNodeView as any);

function kindClass(kind: string): string {
  return KIND_CLASS[kind] ?? '';
}

const editPlaceholder = computed(() => {
  const k = editing.value?.kind;
  if (k === 'bytes') return '输入 hex（可带空格）';
  if (k === 'varint') return '输入十进制或 0x 十六进制';
  if (k === 'fixed32') return '输入 0~4294967295（或 0x）';
  return '输入新值';
});

function nodeInitialValue(n: ProtoNode): string {
  switch (n.kind) {
    case 'varint':
      return n.rawVarint?.toString() ?? '';
    case 'fixed32':
      return (n.rawFixed32 ?? 0).toString();
    case 'fixed64':
      return n.rawFixed64?.toString() ?? '';
    case 'string':
      return n.rawBytes ? new TextDecoder().decode(n.rawBytes) : '';
    case 'bytes':
      return n.rawBytes ? Array.from(n.rawBytes).map(x => x.toString(16).padStart(2, '0')).join(' ') : '';
    default:
      return '';
  }
}

function openEdit(n: ProtoNode) {
  editing.value = n;
  editInput.value = nodeInitialValue(n);
  editError.value = '';
  editVisible.value = true;
}

function confirmEdit() {
  if (!editing.value) return;
  const r = editNodeValue(editing.value, editInput.value);
  if (!r.ok) {
    editError.value = r.msg ?? '格式错误';
    return;
  }
  editError.value = '';
  dirty.value = true;
  editVisible.value = false;
}

function expandAll() {
  openAll.value = true;
  expandTick.value++;
}

function collapseAll() {
  openAll.value = false;
  expandTick.value++;
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function exportJson() {
  download(`${info.value?.name ?? 'proto'}.json`, new Blob([JSON.stringify(protoTreeToJson(nodes.value), null, 2)], { type: 'application/json' }));
  ElMessage({ message: '已导出 JSON 树', type: 'success' });
}

function exportText() {
  download(`${info.value?.name ?? 'proto'}.txt`, new Blob([protoTreeToText(nodes.value)], { type: 'text/plain' }));
  ElMessage({ message: '已导出文本树', type: 'success' });
}

function exportRaw() {
  const bytes = dirty.value ? encodeProtoMessage(nodes.value) : raw.value;
  if (!bytes) return;
  download(`${info.value?.name ?? 'proto'}.bytes`, new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
  ElMessage({ message: `已导出 .bytes（${bytes.length} B）`, type: 'success' });
}

async function save() {
  if (!info.value || !dirty.value) return;
  saving.value = true;
  try {
    const newBytes = encodeProtoMessage(nodes.value);
    const ok = await store.applyTextAssetBytes(info.value.fileId, info.value.pathId, newBytes);
    if (ok) {
      raw.value = newBytes;
      dirty.value = false;
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!info.value) return;
  try {
    const bytes = await store.getTextAssetRaw(info.value.fileId, info.value.pathId);
    raw.value = bytes;
    const decoded = decodeProtoMessage(bytes);
    annotateProtoTree(decoded);
    nodes.value = decoded;
  } catch (e) {
    error.value = `${e}`;
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.proto-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: linear-gradient(160deg, #1b1f2a 0%, #14171f 100%);
  color: #e6e8ee;
  overflow: hidden;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  flex-shrink: 0;

  .asset-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--el-color-primary);
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);

    .new-len {
      color: #ffa657;
    }
  }

  .spacer {
    flex: 1;
  }
}

.proto-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.proto-hex {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.3);
  font-size: 12px;

  .hex-title {
    color: rgba(255, 255, 255, 0.45);
    white-space: nowrap;
  }

  code {
    color: #7ee787;
    font-family: 'JetBrains Mono', Consolas, monospace;
    word-break: break-all;
  }

  .hex-dirty {
    color: #ffa657;
    white-space: nowrap;
  }
}

.proto-tree {
  display: flex;
  flex-direction: column;
}

.proto-loading,
.proto-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;

  .is-loading {
    animation: proto-rotating 1s linear infinite;
  }
}

.proto-error {
  color: #f56c6c;
}

@keyframes proto-rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

:deep(.proto-row) {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding-top: 1px;
  padding-bottom: 1px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  border-radius: 4px;
  transition: background 0.15s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.05);
  }
}

:deep(.proto-toggle) {
  width: 12px;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;

  &.proto-toggle-empty {
    cursor: default;
  }
}

:deep(.proto-field) {
  color: #79c0ff;
  font-weight: 600;
  flex-shrink: 0;
}

:deep(.proto-kind) {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  flex-shrink: 0;
  text-transform: lowercase;

  &.kind-varint {
    color: #ff7b72;
    background: rgba(255, 123, 114, 0.12);
  }
  &.kind-fixed {
    color: #d2a8ff;
    background: rgba(210, 168, 255, 0.12);
  }
  &.kind-string {
    color: #7ee787;
    background: rgba(126, 231, 135, 0.12);
  }
  &.kind-bytes {
    color: #79c0ff;
    background: rgba(121, 192, 255, 0.12);
  }
  &.kind-message {
    color: #ffa657;
    background: rgba(255, 166, 87, 0.12);
  }
}

:deep(.proto-value) {
  color: #d5d9e2;
  word-break: break-all;
  white-space: pre-wrap;
  cursor: pointer;
}

:deep(.proto-msg-label) {
  color: #ffa657;
  cursor: pointer;
}

:deep(.proto-children) {
  display: flex;
  flex-direction: column;
}

:deep(.proto-edit) {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.35);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.15s ease;

  &:hover {
    color: var(--el-color-primary);
  }
}

:deep(.proto-row:hover .proto-edit) {
  opacity: 1;
}

:deep(.sem-badge) {
  flex-shrink: 0;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  color: #79c0ff;
  background: rgba(121, 192, 255, 0.12);

  &.sem-strong {
    color: #ff7b72;
    background: rgba(255, 123, 114, 0.16);
  }
}

.edit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;

  .edit-path {
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-weight: 700;
    color: #79c0ff;
  }

  .edit-semantic {
    font-size: 12px;
    color: #79c0ff;
    background: rgba(121, 192, 255, 0.12);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .edit-strong {
    font-size: 12px;
    color: #ff7b72;
    background: rgba(255, 123, 114, 0.16);
    padding: 2px 6px;
    border-radius: 4px;
  }
}

.edit-input {
  :deep(.el-input__inner) {
    font-family: 'JetBrains Mono', Consolas, monospace;
  }
}

.edit-error {
  margin-top: 8px;
  color: #f56c6c;
  font-size: 12px;
}
</style>
