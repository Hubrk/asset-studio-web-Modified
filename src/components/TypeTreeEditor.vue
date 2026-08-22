<template>
  <div class="typetree-editor">
    <div class="toolbar">
      <span class="asset-type">{{ asset.type }}</span>
      <span class="asset-name">{{ asset.name }}</span>
      <div class="spacer" />
      <el-button size="small" @click="handleFormat" :disabled="!jsonText">
        格式化
      </el-button>
      <el-button size="small" @click="handleReset" :disabled="!hasEdits">
        重置
      </el-button>
      <el-button type="success" size="small" :loading="applying" @click="handleApply" :disabled="!hasEdits || !isValid">
        应用修改
      </el-button>
    </div>
    <div class="editor-container">
      <div v-if="!hasTypeTree" class="no-typetree">
        <el-icon :size="48" color="#c0c4cc"><i-el-document-delete /></el-icon>
        <p>该资产没有 TypeTree 数据，无法编辑</p>
        <p class="hint">只有包含 TypeTree 的资产才能通过 JSON 编辑。Texture2D、Sprite、TextAsset 等类型请使用专用编辑器。</p>
      </div>
      <div v-else class="editor-wrap">
        <div v-if="!isValid" class="json-error">
          <el-icon color="#f56c6c"><i-el-warning-filled /></el-icon>
          <span>{{ parseError }}</span>
        </div>
        <textarea
          ref="textareaRef"
          v-model="jsonText"
          class="json-textarea"
          spellcheck="false"
          @input="onInput"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AssetInfo } from '@/workers/assetManager';
import { useAssetManager } from '@/store/assetManager';

const props = defineProps<{
  asset: AssetInfo;
  data: any;
}>();

const assetManager = useAssetManager();

const textareaRef = ref<HTMLTextAreaElement>();
const jsonText = ref('');
const originalText = ref('');
const applying = ref(false);
const hasEdits = ref(false);
const isValid = ref(true);
const parseError = ref('');
const hasTypeTree = ref(false);

// bigint 无法直接 JSON 序列化，统一转成十进制字符串（避免精度丢失）
const handleJsonBigint = (num: bigint) => num.toString();

watch(
  () => props.data,
  newData => {
    // Check if TypeTree data exists
    const typeTree = props.asset.preview.typeTree;
    hasTypeTree.value = !!(typeTree && Object.keys(typeTree).length > 0);

    if (!hasTypeTree.value) {
      jsonText.value = '';
      originalText.value = '';
      hasEdits.value = false;
      return;
    }

    // Format the TypeTree JSON with bigint handling
    const text = JSON.stringify(
      typeTree,
      (key, value) => (typeof value === 'bigint' ? handleJsonBigint(value) : value),
      2,
    );
    jsonText.value = text;
    originalText.value = text;
    hasEdits.value = false;
    isValid.value = true;
    parseError.value = '';
  },
  { immediate: true },
);

const onInput = () => {
  hasEdits.value = jsonText.value !== originalText.value;
  // Validate JSON
  if (jsonText.value.trim()) {
    try {
      JSON.parse(jsonText.value);
      isValid.value = true;
      parseError.value = '';
    } catch (e: any) {
      isValid.value = false;
      parseError.value = e.message;
    }
  } else {
    isValid.value = false;
    parseError.value = 'JSON 不能为空';
  }
};

const handleFormat = () => {
  try {
    const parsed = JSON.parse(jsonText.value);
    jsonText.value = JSON.stringify(
      parsed,
      (key, value) => (typeof value === 'bigint' ? handleJsonBigint(value) : value),
      2,
    );
    hasEdits.value = jsonText.value !== originalText.value;
  } catch {
    // Ignore format errors
  }
};

const handleReset = () => {
  jsonText.value = originalText.value;
  hasEdits.value = false;
  isValid.value = true;
  parseError.value = '';
};

const handleApply = async () => {
  if (!isValid.value) return;
  applying.value = true;
  try {
    const parsed = JSON.parse(jsonText.value);
    const ok = await assetManager.modifyAssetByJson(
      props.asset.fileId,
      props.asset.pathId,
      parsed,
    );
    if (ok) {
      originalText.value = jsonText.value;
      hasEdits.value = false;
    }
  } catch (e: any) {
    ElMessage({ message: `JSON 解析失败：${e.message}`, type: 'error' });
  } finally {
    applying.value = false;
  }
};

defineExpose({ hasEdits });
</script>

<style lang="scss" scoped>
.typetree-editor {
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

  .asset-type {
    font-size: 12px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--el-color-primary-light-9);
    color: var(--el-color-primary);
    font-family: monospace;
  }

  .asset-name {
    font-size: 12px;
    color: var(--el-text-color-regular);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.spacer {
  flex: 1;
}

.editor-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.no-typetree {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 12px;
  color: var(--el-text-color-secondary);

  p {
    margin: 0;
    font-size: 14px;
  }

  .hint {
    font-size: 12px;
    max-width: 400px;
    text-align: center;
    line-height: 1.6;
  }
}

.editor-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}

.json-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--el-color-error-light-9);
  color: var(--el-color-error);
  font-size: 12px;
  font-family: monospace;
  flex-shrink: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.json-textarea {
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
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  overflow: auto;
}
</style>
