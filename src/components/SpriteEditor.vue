<template>
  <div class="sprite-editor">
    <div class="toolbar">
      <span class="label">Pixels To Units</span>
      <el-input-number
        v-model="pixelsToUnits"
        :min="0"
        :precision="2"
        :step="1"
        size="small"
        style="width: 160px"
      />
      <div class="spacer" />
      <el-button size="small" @click="handleReset" :disabled="!hasChanges">
        重置
      </el-button>
      <el-button type="success" size="small" :loading="applying" @click="handleApply" :disabled="!hasChanges">
        应用修改
      </el-button>
    </div>
    <div class="info-area">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="名称">{{ asset?.name }}</el-descriptions-item>
        <el-descriptions-item label="原始值">{{ originalValue }}</el-descriptions-item>
      </el-descriptions>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { AssetInfo } from '@/workers/assetManager';
import { useAssetManager } from '@/store/assetManager';

const props = defineProps<{ asset: AssetInfo }>();
const assetManager = useAssetManager();

const originalValue = ref<number>(100);
const pixelsToUnits = ref<number>(100);
const applying = ref(false);

const hasChanges = computed(() => pixelsToUnits.value !== originalValue.value);

// 从 inspect 数据读取原始 pixelsToUnits 值
watch(
  () => props.asset,
  () => {
    if (!props.asset) return;
    const inspect = (props.asset.preview as any)?.inspect;
    const val = inspect?.pixelsToUnits;
    if (typeof val === 'number') {
      originalValue.value = val;
      pixelsToUnits.value = val;
    }
  },
  { immediate: true },
);

const handleReset = () => {
  pixelsToUnits.value = originalValue.value;
};

const handleApply = async () => {
  if (!props.asset || !hasChanges.value) return;
  applying.value = true;
  try {
    await assetManager.modifySpritePixelsToUnits(
      props.asset.fileId,
      props.asset.pathId,
      pixelsToUnits.value,
    );
    originalValue.value = pixelsToUnits.value;
  } finally {
    applying.value = false;
  }
};
</script>

<style scoped>
.sprite-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
  padding: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  font-size: 14px;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.info-area {
  padding: 4px 0;
}
</style>
