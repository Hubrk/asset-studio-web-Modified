<template>
  <el-dialog v-model="show" title="Export options" width="min(500px, calc(100vw - 16px))">
    <el-form label-width="auto" label-position="top">
      <el-form-item label="Group exported assets by">
        <el-select v-model="setting.data.exportGroupMethod" :style="{ width: '200px' }">
          <el-option v-for="{ label, value } in exportGroupMethodOptions" :key="value" :label="label" :value="value" />
        </el-select>
      </el-form-item>
      <el-form-item class="fsb-convert-format" label="FSB audio convert format">
        <el-select v-model="setting.data.fsbConvertFormat" :style="{ width: '200px' }">
          <el-option v-for="{ label, value } in fsbConvertFormatOptions" :key="value" :label="label" :value="value" />
        </el-select>
        <div style="line-height: 1.5; margin-top: 4px">
          <el-text type="info">Only affects the export format. The preview format is always WAV.</el-text>
        </div>
      </el-form-item>
      <el-form-item v-if="setting.data.fsbConvertFormat === FsbConvertFormat.MP3" label="MP3 VBR quality">
        <el-slider
          v-model="fsbConvertVbrQuality"
          class="vbr-quality-slider"
          show-stops
          :step="1"
          :min="0"
          :max="9"
          :marks="fsbConvertVbrQualitySliderMarks"
          :show-tooltip="false"
        />
      </el-form-item>
      <el-form-item label="Export to">
        <el-radio-group v-model="setting.data.exportTarget">
          <el-radio value="directory">directory</el-radio>
          <el-radio value="zip">zip download</el-radio>
        </el-radio-group>
        <div style="line-height: 1.5; margin-top: 4px">
          <el-text type="info">"directory" needs a desktop browser (File System Access API); "zip" works everywhere.</el-text>
        </div>
      </el-form-item>
      <el-form-item label="Bundle compression">
        <el-select v-model="compressionModeModel" :style="{ width: '200px' }">
          <el-option label="None" :value="0" />
          <el-option label="LZ4_HC (game compatible)" :value="3" />
          <el-option label="LZ4" :value="2" />
        </el-select>
        <div style="line-height: 1.5; margin-top: 4px">
          <el-text type="info">Only affects re-packed output (modified / encrypted bundles).</el-text>
        </div>
      </el-form-item>
      <el-form-item label="Naming rules">
        <el-row :gutter="12" class="naming-row">
          <el-col :span="12">
            <div class="naming-label">Duplicate suffix</div>
            <el-select v-model="setting.data.exportRenameStyle" :style="{ width: '100%' }">
              <el-option label="name (2).png" value="paren" />
              <el-option label="name_2.png" value="underscore" />
            </el-select>
          </el-col>
          <el-col :span="12">
            <div class="naming-label">Type suffix in zip</div>
            <el-checkbox v-model="setting.data.exportZipSuffix">foo_encrypted.assetbundle</el-checkbox>
          </el-col>
        </el-row>
        <div style="line-height: 1.5; margin-top: 4px">
          <el-text type="info">Applied to re-named files on export; zip entries keep original names unless the type suffix option is enabled.</el-text>
        </div>
      </el-form-item>
    </el-form>
  </el-dialog>
</template>

<script setup lang="ts">
import { FsbConvertFormat, useSetting } from '@/store/setting';
import { useAssetManager } from '@/store/assetManager';
import { ExportGroupMethod } from '@/types/export';

const setting = useSetting();
const assetManager = useAssetManager();

const show = ref(false);

/** 写回 bundle 的压缩格式：与纹理编辑器/批量工作流共用同一 store 设置 */
const compressionModeModel = computed({
  get: () => assetManager.compressionMode,
  set: (v: number) => {
    assetManager.setCompressionMode(v);
  },
});

const exportGroupMethodOptions: Array<{ label: string; value: ExportGroupMethod }> = [
  {
    label: 'do not group',
    value: ExportGroupMethod.NONE,
  },
  {
    label: 'type name',
    value: ExportGroupMethod.TYPE_NAME,
  },
  {
    label: 'source file name',
    value: ExportGroupMethod.SOURCE_FILE_NAME,
  },
  {
    label: 'container path',
    value: ExportGroupMethod.CONTAINER_PATH,
  },
];

const fsbConvertFormatOptions: Array<{ label: string; value: FsbConvertFormat }> = [
  {
    label: 'wav (32-bit float PCM)',
    value: FsbConvertFormat.WAV,
  },
  {
    label: 'mp3 (VBR)',
    value: FsbConvertFormat.MP3,
  },
];

const fsbConvertVbrQuality = computed({
  get: () => 9 - setting.data.fsbConvertVbrQuality,
  set: value => {
    setting.data.fsbConvertVbrQuality = 9 - value;
  },
});

const fsbConvertVbrQualitySliderMarks = {
  0: {
    label: 'lowest',
    style: {
      transform: 'translateX(-3px)',
    },
  },
  9: {
    label: 'highest',
    style: {
      transform: 'translateX(calc(-100% + 3px))',
    },
  },
};

defineExpose({
  open: () => {
    show.value = true;
  },
});
</script>

<style lang="scss" scoped>
.vbr-quality-slider {
  --el-slider-stop-bg-color: var(--el-color-info-light-5);
  width: 300px;
  margin: 0 3px;

  :deep(.el-slider__marks-stop:first-of-type) {
    background-color: var(--el-slider-main-bg-color);
  }
}

.fsb-convert-format {
  :deep(.el-form-item__content) {
    flex-direction: column;
    align-items: flex-start;
  }
}

.naming-row {
  width: 100%;
}

.naming-label {
  margin-bottom: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}
</style>
