<template>
  <el-tabs v-model="activePane" class="asset-preview" type="border-card">
    <el-tab-pane v-if="enablePreview" :label="messages.preview" :name="PreviewTab.Preview" />
    <el-tab-pane v-if="canEdit" label="Edit" :name="PreviewTab.Edit" />
    <el-tab-pane :label="messages.typeTree" :name="PreviewTab.TypeTree" />
    <el-tab-pane :label="messages.inspect" :name="PreviewTab.Inspect" />
    <div class="asset-preview-pane">
      <KeepAlive :exclude="['AssetTextViewer', 'AssetTypeTreeViewer', 'TextureEditor', 'TextAssetEditor', 'SpriteEditor', 'TypeTreeEditor']">
        <component
          :is="PreviewComponent"
          :asset="assetManager.curAssetInfo!"
          :data="previewData"
          :desc="enablePreview ? undefined : messages.previewDisabled"
          :loading="previewDataLoadingDebounced"
          @goto-asset="(key: string) => emits('gotoAsset', key)"
          @update-payload="(payload: any) => (previewPayload = payload)"
        />
      </KeepAlive>
    </div>
  </el-tabs>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { computedAsync } from '@vueuse/core';
import { identity } from 'es-toolkit';
import AssetAudioViewer from '@/components/AssetAudioViewer.vue';
import AssetImageViewer from '@/components/AssetImageViewer.vue';
import AssetDumpViewer from '@/components/AssetInspectViewer.vue';
import AssetNoPreview from '@/components/AssetNoPreview.vue';
import AssetSpineViewer from '@/components/AssetSpineViewer.vue';
import AssetTextViewer from '@/components/AssetTextViewer.vue';
import AssetTypeTreeViewer from '@/components/AssetTypeTreeViewer.vue';
import AssetFrameAnimationViewer from '@/components/AssetFrameAnimationViewer.vue';
import TextureEditor from '@/components/TextureEditor.vue';
import TextAssetEditor from '@/components/TextAssetEditor.vue';
import KfbAssetEditor from '@/components/KfbAssetEditor.vue';
import TypeTreeEditor from '@/components/TypeTreeEditor.vue';
import { useRefDebouncedConditional } from '@/hooks/useRef';
import { useAssetManager } from '@/store/assetManager';
import { useSetting } from '@/store/setting';
import { PreviewType } from '@/types/preview';
import { useLocale } from '@/composables/useLocale';

const { messages } = useLocale();

const emits = defineEmits<{
  (e: 'gotoAsset', key: string): void;
}>();

enum PreviewTab {
  Preview = 'preview',
  Edit = 'edit',
  TypeTree = 'typeTree',
  Inspect = 'inspect',
}

const assetManager = useAssetManager();
const setting = useSetting();

const enablePreview = computed(() => setting.data.enablePreview);

/**
 * Whether the current asset can be edited.
 * - Texture2D / TextAsset: use dedicated specialized editors
 * - Any other asset with TypeTree data: use TypeTreeEditor (full JSON editor)
 */
const canEdit = computed(() => {
  const info = assetManager.curAssetInfo;
  if (!info) return false;

  // Dedicated editors for specific types
  if (info.preview.type === PreviewType.Image || info.preview.type === PreviewType.Text) {
    if ((info.preview as any).canEdit) return true;
  }

  // Generic TypeTree editor for any asset with TypeTree data
  const typeTree = info.preview.typeTree;
  if (typeTree && Object.keys(typeTree).length > 0) return true;

  return false;
});

const activePane = ref(enablePreview.value ? PreviewTab.Preview : PreviewTab.TypeTree);

const previewPayload = shallowRef<any>();
const previewDataLoading = ref(false);
const previewDataLoadingDebounced = useRefDebouncedConditional({
  source: previewDataLoading,
  delay: 300,
  condition: identity,
});

watch(
  () => assetManager.curAssetInfo,
  () => {
    previewPayload.value = undefined;
    previewDataLoading.value = true;
  },
  { flush: 'sync' },
);

watch(enablePreview, v => {
  activePane.value = v
    ? PreviewTab.Preview
    : activePane.value === PreviewTab.Preview
      ? PreviewTab.TypeTree
      : activePane.value;
});

watch(canEdit, v => {
  if (!v && activePane.value === PreviewTab.Edit) {
    activePane.value = enablePreview.value ? PreviewTab.Preview : PreviewTab.TypeTree;
  }
});

watch(
  () => assetManager.pendingEditTab,
  v => {
    if (v && canEdit.value) {
      activePane.value = PreviewTab.Edit;
      assetManager.pendingEditTab = false;
    }
  },
);

const previewDataAsync = computedAsync(
  async () => {
    void assetManager.previewVersion;
    if (!enablePreview.value && activePane.value !== PreviewTab.Edit) return null;
    const info = assetManager.curAssetInfo;
    if (!info) return null;
    const {
      preview: { type },
    } = info;
    if (type === PreviewType.None || (type === PreviewType.ImageList && !previewPayload.value)) return null;
    const data = await assetManager.loadPreviewData(
      info,
      type === PreviewType.ImageList || type === PreviewType.FrameAnimation ? previewPayload.value : undefined,
    );
    return data ?? null;
  },
  null,
  {
    evaluating: previewDataLoading,
  },
);

const previewData = computed(() => (previewDataLoading.value ? null : previewDataAsync.value));

/**
 * Determine which editor to show in the Edit tab.
 * - Texture2D: TextureEditor (image replacement)
 * - TextAsset: TextAssetEditor (text editing)
 * - Everything else with TypeTree: TypeTreeEditor (full JSON editor, including Sprite, Material, MonoBehaviour, etc.)
 */
const EditComponent = computed(() => {
  const info = assetManager.curAssetInfo;
  if (!info) return AssetNoPreview;

  // KFB 战斗逻辑容器：独立编辑器（自动解密 XML + 密钥配置）
  if (info.preview.type === PreviewType.Text && (info.preview as any).kfbContainer) return KfbAssetEditor;

  // Dedicated editors for specialized types
  if (info.preview.type === PreviewType.Text && (info.preview as any).canEdit) return TextAssetEditor;
  if (info.preview.type === PreviewType.Image) return TextureEditor;

  // Generic TypeTree editor for everything else (Sprite, Material, MonoBehaviour, etc.)
  const typeTree = info.preview.typeTree;
  if (typeTree && Object.keys(typeTree).length > 0) return TypeTreeEditor;

  return AssetNoPreview;
});

const PreviewComponent = computed(() => {
  const info = assetManager.curAssetInfo;
  if (!info) return AssetNoPreview;
  switch (activePane.value) {
    case PreviewTab.Preview: {
      switch (info.preview.type) {
        case PreviewType.Image:
        case PreviewType.ImageList:
          return AssetImageViewer;
        case PreviewType.Text:
          return AssetTextViewer;
        case PreviewType.Audio:
          return AssetAudioViewer;
        case PreviewType.Spine:
          return AssetSpineViewer;
        case PreviewType.FrameAnimation:
          return AssetFrameAnimationViewer;
        default:
          return AssetNoPreview;
      }
    }
    case PreviewTab.Edit:
      return EditComponent.value;
    case PreviewTab.TypeTree:
      return AssetTypeTreeViewer;
    case PreviewTab.Inspect:
      return AssetDumpViewer;
    default:
      return AssetNoPreview;
  }
});
</script>

<style lang="scss" scoped>
.asset-preview {
  --el-tabs-header-height: 36px;
  display: flex;
  width: 100%;
  height: 100%;

  &-pane {
    width: 100%;
    height: 100%;
  }

  :deep(.el-tabs__content) {
    padding: 0;
    flex-grow: 1;
    flex-shrink: 1;
    min-height: 0;
  }

  :deep(.el-tab-pane) {
    display: none;
  }
}
</style>
