<template>
  <div class="text-editor">
    <div class="toolbar">
      <el-select v-model="language" size="small" style="width: 120px">
        <el-option label="Plain Text" value="plaintext" />
        <el-option label="JSON" value="json" />
        <el-option label="XML" value="xml" />
        <el-option label="Lua" value="lua" />
        <el-option label="CS" value="csharp" />
        <el-option label="JS" value="javascript" />
      </el-select>
      <span class="encoding-info">UTF-8</span>
      <div class="spacer" />
      <el-button size="small" @click="handleReset" :disabled="!hasEdits">
        重置
      </el-button>
      <el-button type="success" size="small" :loading="applying" @click="handleApply" :disabled="!hasEdits">
        应用修改
      </el-button>
    </div>
    <div class="editor-container">
      <textarea
        ref="textareaRef"
        v-model="textContent"
        class="text-area"
        spellcheck="false"
        @input="onInput"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AssetInfo } from '@/workers/assetManager';
import { useAssetManager } from '@/store/assetManager';

const props = defineProps<{
  asset: AssetInfo;
  data: string | null;
}>();

const assetManager = useAssetManager();

const textareaRef = ref<HTMLTextAreaElement>();
const textContent = ref('');
const originalContent = ref('');
const applying = ref(false);
const hasEdits = ref(false);
const language = ref('plaintext');

const detectLanguage = (name: string, content: string): string => {
  if (name.endsWith('.json') || content.trim().startsWith('{')) return 'json';
  if (name.endsWith('.xml') || content.trim().startsWith('<')) return 'xml';
  if (name.endsWith('.lua')) return 'lua';
  if (name.endsWith('.cs')) return 'csharp';
  if (name.endsWith('.js')) return 'javascript';
  return 'plaintext';
};

watch(
  () => props.data,
  newData => {
    const text = newData ?? '';
    textContent.value = text;
    originalContent.value = text;
    hasEdits.value = false;
    language.value = detectLanguage(props.asset.name, text);
  },
  { immediate: true },
);

const onInput = () => {
  hasEdits.value = textContent.value !== originalContent.value;
};

const handleReset = () => {
  textContent.value = originalContent.value;
  hasEdits.value = false;
};

const handleApply = async () => {
  applying.value = true;
  try {
    const ok = await assetManager.modifyTextAsset(
      props.asset.fileId,
      props.asset.pathId,
      textContent.value,
    );
    if (ok) {
      originalContent.value = textContent.value;
      hasEdits.value = false;
    }
  } finally {
    applying.value = false;
  }
};

defineExpose({ hasEdits });
</script>

<style lang="scss" scoped>
.text-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.encoding-info {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.spacer {
  flex: 1;
}

.editor-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.text-area {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  tab-size: 4;
  white-space: pre;
  overflow-wrap: normal;
  overflow: auto;
}
</style>
