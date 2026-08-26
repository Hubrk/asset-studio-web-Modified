<template>
  <div class="kfb-viewer">
    <div class="kfb-header">
      <div class="kfb-title">
        <el-icon class="kfb-icon"><Coin /></el-icon>
        <span>KFB 战斗逻辑编辑器</span>
      </div>
      <div class="kfb-actions">
        <el-button
          v-if="originalBytes && current"
          size="small"
          type="primary"
          :loading="exporting"
          :disabled="!current"
          @click="onExport"
        >
          <el-icon v-if="!exporting"><Download /></el-icon>
          {{ exporting ? '导出中…' : '导出加密 AssetBundle' }}
        </el-button>
      </div>
    </div>

    <div class="kfb-drop" :class="{ 'drag-over': dragOver }" @dragover.prevent="dragOver = true" @dragleave="dragOver = false" @drop.prevent.stop="onDrop">
      <el-icon class="drop-icon"><UploadFilled /></el-icon>
      <div class="drop-text">
        <template v-if="fileName">
          <span class="file-name">{{ fileName }}</span>
          <span class="file-size">{{ fileSize }}</span>
        </template>
        <template v-else>
          <span>拖入 KFB 加密的 <b>.assetbundle</b> 文件，或</span>
          <el-button size="small" type="primary" plain @click="pickFile">选择文件</el-button>
        </template>
      </div>
      <input ref="fileInput" type="file" accept=".assetbundle,.ab" hidden @change="onFileChange" />
    </div>

    <div class="kfb-controls">
      <div class="key-row">
        <el-input
          v-model="keyText"
          class="key-input"
          placeholder="AES-256 Key（64 位十六进制）"
          clearable
          :disabled="decoding"
        >
          <template #prepend>Key</template>
        </el-input>
        <el-button type="primary" :loading="decoding" :disabled="!originalBytes || !isValidKey" @click="onDecode">
          <el-icon v-if="!decoding"><MagicStick /></el-icon>
          {{ decoding ? '解密中…' : '解密并解析' }}
        </el-button>
      </div>
      <div v-if="candidates.length > 1" class="candidate-row">
        <span class="label">TextAsset：</span>
        <el-select
          v-model="selectedName"
          size="small"
          filterable
          placeholder="选择要编辑的 TextAsset"
          class="candidate-select"
          @change="onDecode"
        >
          <el-option v-for="c in candidates" :key="c" :value="c" :label="c" />
        </el-select>
        <span class="candidate-count">共 {{ candidates.length }} 个</span>
      </div>
    </div>

    <div v-if="current" class="kfb-body">
      <div class="kfb-meta">
        <span class="meta-item"><b>{{ current.name }}</b></span>
        <span class="meta-item">semantic {{ current.semantic.length.toLocaleString() }} 字符</span>
        <span class="meta-item">XML {{ current.xml.length.toLocaleString() }} 字符</span>
        <span class="meta-item replaced-hint" :title="'修改会写入并重新加密导出'">战斗数值可直接在「语义 JSON」页编辑</span>
      </div>
      <el-tabs v-model="activeTab" class="kfb-tabs">
        <el-tab-pane label="语义 JSON（可编辑）" name="semantic">
          <div class="editor-wrap">
            <div class="editor-toolbar">
              <el-button size="small" @click="formatJson">格式化</el-button>
              <el-button size="small" @click="validateJson">校验 JSON</el-button>
              <span v-if="jsonValid === true" class="ok-hint">✅ JSON 合法</span>
              <span v-else-if="jsonValid === false" class="err-hint">❌ {{ jsonError }}</span>
            </div>
            <textarea
              v-model="semanticText"
              class="kfb-editor"
              spellcheck="false"
              placeholder="KH.ActorData 战斗数值 JSON…"
            ></textarea>
          </div>
        </el-tab-pane>
        <el-tab-pane label="XML（只读）" name="xml">
          <textarea :value="current.xml" class="kfb-editor" readonly spellcheck="false"></textarea>
        </el-tab-pane>
        <el-tab-pane label="可读 JSON（只读）" name="runtime">
          <textarea :value="current.runtime" class="kfb-editor" readonly spellcheck="false"></textarea>
        </el-tab-pane>
      </el-tabs>
    </div>

    <div v-else class="kfb-empty">
      <el-icon><Document /></el-icon>
      <span>{{ emptyHint }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useLocalStorage } from '@vueuse/core';
import { Coin, Document, Download, MagicStick, UploadFilled } from '@element-plus/icons-vue';
import { useAssetManager } from '@/store/assetManager';

const DEFAULT_KEY = 'e9d92700019be4f8a244a98871bef652052e74ff7d5961c71c57a33644af523e';
const KEY_STORAGE = 'kfb-default-key';

const store = useAssetManager();

const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);
const fileName = ref('');
const fileSize = ref('');
const originalBytes = ref<Uint8Array | null>(null);
const keyText = useLocalStorage(KEY_STORAGE, DEFAULT_KEY);
const decoding = ref(false);
const exporting = ref(false);
const candidates = ref<string[]>([]);
const selectedName = ref('');
const current = ref<{ name: string; semantic: string; xml: string; runtime: string } | null>(null);
const activeTab = ref('semantic');
const semanticText = ref('');
const jsonValid = ref<boolean | null>(null);
const jsonError = ref('');

const emptyHint = computed(() =>
  fileName.value
    ? '输入 Key 后点「解密并解析」'
    : '请先拖入或选择 KFB 加密的 .assetbundle 文件',
);

const isValidKey = computed(() => /^[0-9a-fA-F]{64}$/.test(keyText.value.trim()));

const formatBytes = (n: number) =>
  n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;

function pickFile() {
  fileInput.value?.click();
}

async function onFileChange(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  (ev.target as HTMLInputElement).value = '';
  if (file) await loadFile(file);
}

async function onDrop(ev: DragEvent) {
  dragOver.value = false;
  const file = ev.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
}

async function loadFile(file: File) {
  fileName.value = file.name;
  fileSize.value = formatBytes(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  originalBytes.value = bytes;
  current.value = null;
  candidates.value = [];
  selectedName.value = '';
  semanticText.value = '';
  jsonValid.value = null;
}

async function onDecode() {
  if (!originalBytes.value) return;
  decoding.value = true;
  try {
    const result = await store.kfbDecode(originalBytes.value, keyText.value.trim(), selectedName.value || undefined);
    candidates.value = result.candidates;
    if (!result.name) {
      // 多候选未选择：只填充候选列表，渲染 radio 等待用户选择
      current.value = null;
      semanticText.value = '';
      jsonValid.value = null;
      ElMessage({ message: `找到 ${result.candidates.length} 个 TextAsset，请选择要编辑的一个`, type: 'info' });
      return;
    }
    current.value = {
      name: result.name,
      semantic: result.semantic,
      xml: result.xml,
      runtime: result.runtime,
    };
    if (!selectedName.value) selectedName.value = result.name;
    semanticText.value = result.semantic;
    jsonValid.value = null;
    ElMessage({ message: `解密成功：${result.name}（${(result.semantic.length / 1024).toFixed(0)}KB 语义数据）`, type: 'success' });
  } catch (e) {
    ElMessage({ message: `解密失败：${e}`, type: 'error' });
    current.value = null;
  } finally {
    decoding.value = false;
  }
}

function formatJson() {
  try {
    semanticText.value = JSON.stringify(JSON.parse(semanticText.value), null, 2);
    jsonValid.value = true;
    jsonError.value = '';
  } catch (e) {
    jsonValid.value = false;
    jsonError.value = `${e}`;
  }
}

function validateJson() {
  try {
    JSON.parse(semanticText.value);
    jsonValid.value = true;
    jsonError.value = '';
  } catch (e) {
    jsonValid.value = false;
    jsonError.value = `${e}`;
  }
}

async function onExport() {
  if (!originalBytes.value || !current.value) return;
  // 导出内容取当前编辑态文本；tab 决定格式
  let text = semanticText.value;
  let format: 'semantic' | 'xml' | 'runtime' = 'semantic';
  if (activeTab.value === 'xml') {
    text = current.value.xml;
    format = 'xml';
  } else if (activeTab.value === 'runtime') {
    text = current.value.runtime;
    format = 'runtime';
  } else {
    // semantic tab：先校验
    try {
      JSON.parse(semanticText.value);
    } catch (e) {
      ElMessage({ message: `语义 JSON 不合法，无法导出：${e}`, type: 'error' });
      return;
    }
  }
  exporting.value = true;
  try {
    const out = await store.kfbExportEncrypted(originalBytes.value, keyText.value.trim(), current.value.name, text, format);
    const blob = new Blob([out as unknown as BlobPart], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = fileName.value.replace(/\.assetbundle$/i, '');
    a.href = url;
    a.download = `${base}_modified.assetbundle`;
    a.click();
    URL.revokeObjectURL(url);
    ElMessage({ message: `已导出 ${a.download}（${formatBytes(out.length)}）`, type: 'success' });
  } catch (e) {
    ElMessage({ message: `导出失败：${e}`, type: 'error' });
  } finally {
    exporting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.kfb-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: linear-gradient(160deg, #1b1f2a 0%, #14171f 100%);
  color: #e6e8ee;
  overflow: hidden;
}

.kfb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);

  .kfb-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
    font-size: 14px;

    .kfb-icon {
      color: var(--el-color-primary);
      font-size: 18px;
    }
  }
}

.kfb-drop {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 16px 0;
  padding: 14px 18px;
  border: 1px dashed rgba(255, 255, 255, 0.18);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  transition: border-color 0.2s ease, background 0.2s ease, transform 0.2s ease;
  cursor: pointer;

  &:hover {
    border-color: var(--el-color-primary);
    background: rgba(255, 255, 255, 0.05);
  }

  &.drag-over {
    border-color: var(--el-color-primary);
    background: rgba(64, 158, 255, 0.12);
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.18), inset 0 0 20px rgba(64, 158, 255, 0.1);
    transform: translateY(-1px);
  }

  .drop-icon {
    font-size: 22px;
    color: var(--el-color-primary);
  }

  .drop-text {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.75);

    .file-name {
      font-weight: 600;
      color: #e6e8ee;
    }

    .file-size {
      color: rgba(255, 255, 255, 0.45);
      font-size: 12px;
    }
  }
}

.kfb-controls {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  .key-row {
    display: flex;
    gap: 8px;

    .key-input {
      flex: 1;
    }
  }

  .candidate-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .label {
      color: rgba(255, 255, 255, 0.6);
      white-space: nowrap;
    }

    .candidate-select {
      width: 240px;
    }

    .candidate-count {
      color: rgba(255, 255, 255, 0.4);
      font-size: 12px;
    }
  }
}

.kfb-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 16px 16px;
  gap: 8px;
}

.kfb-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);

  .meta-item b {
    color: var(--el-color-primary);
  }

  .replaced-hint {
    margin-left: auto;
    color: rgba(255, 255, 255, 0.4);
  }
}

.kfb-tabs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;

  :deep(.el-tabs__content) {
    flex: 1;
    min-height: 0;
  }

  :deep(.el-tab-pane) {
    height: 100%;
  }
}

.editor-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 6px;

  .editor-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;

    .ok-hint {
      color: #67c23a;
      font-size: 12px;
    }

    .err-hint {
      color: #f56c6c;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 400px;
    }
  }
}

.kfb-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  color: #d5d9e2;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: none;
  outline: none;
  tab-size: 2;

  &:focus {
    border-color: var(--el-color-primary);
  }
}

.kfb-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: rgba(255, 255, 255, 0.3);

  .el-icon {
    font-size: 36px;
  }
}
</style>
