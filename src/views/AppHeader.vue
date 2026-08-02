<template>
  <div class="menu-bar">
    <MenuBar :config="menuConfig">
      <template #right>
        <el-tooltip :content="isDark ? messages.lightMode : messages.darkMode" placement="bottom">
          <el-button
            class="theme-btn"
            :icon="isDark ? IElMoon : IElSunny"
            circle
            text
            @click="useDarkMode().toggle()"
          />
        </el-tooltip>
        <el-button class="github-btn" :icon="IconGithub" circle text @click="gotoGithub" />
      </template>
    </MenuBar>
    <ExportOptionsDialog ref="exportOptionsDialogRef" />
    <UnityCNOptionsDialog ref="unityCNOptionsDialogRef" />
    <AddRepoSourceDialog ref="addRepoSourceDialogRef" />
    <BatchWorkflowDialog ref="batchWorkflowDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue';
import { BundleEnv } from '@arkntools/unity-js';
import { useFileDialog } from '@vueuse/core';
import IconGithub from '@/assets/github.svg';
import AddRepoSourceDialog from '@/components/AddRepoSourceDialog.vue';
import MenuBar from '@/components/MenuBar.vue';
import type { MenuBarConfig } from '@/components/MenuBar.vue';
import type { MenuDropdownConfigItem } from '@/components/MenuDropdown.vue';
import { useRepoMenuItems } from '@/hooks/useRepoMenuItems';
import { useAssetManager } from '@/store/assetManager';
import { useSetting } from '@/store/setting';
import type { Settings } from '@/store/setting';
import { openUrl } from '@/utils/common';
import { useLocale } from '@/composables/useLocale';
import { useDarkMode } from '@/composables/useDarkMode';
import IElSunny from '~icons/ep/sunny';
import IElMoon from '~icons/ep/moon';
import IElSelect from '~icons/ep/select';
import ExportOptionsDialog from './components/ExportOptionsDialog.vue';
import UnityCNOptionsDialog from './components/UnityCNOptionsDialog.vue';
import BatchWorkflowDialog from '@/components/BatchWorkflow.vue';

const { messages, locale, setLocale } = useLocale();
const { isDark } = useDarkMode();

const emits = defineEmits<{
  (name: 'commandExport', type: string): any;
}>();

const assetManager = useAssetManager();
const setting = useSetting();

const exportOptionsDialogRef = useTemplateRef('exportOptionsDialogRef');
const unityCNOptionsDialogRef = useTemplateRef('unityCNOptionsDialogRef');
const addRepoSourceDialogRef = useTemplateRef('addRepoSourceDialogRef');
const batchWorkflowDialogRef = useTemplateRef('batchWorkflowDialogRef');

const gotoGithub = () => {
  openUrl('https://github.com/arkntools/asset-studio-web');
};

const loadFiles = (list: FileList | null) => {
  if (!list || !list.length) return;
  assetManager.loadFiles([...list]);
};

const { open: openFile, onChange: onFileChange } = useFileDialog({ reset: true });
onFileChange(loadFiles);

const { open: openFolder, onChange: onFolderChange } = useFileDialog({ directory: true, reset: true });
onFolderChange(loadFiles);

const getEnvMenuItem = (name: string, value: Settings['unityEnv'], divided?: boolean): MenuDropdownConfigItem => ({
  name,
  divided,
  handler: () => {
    setting.data.unityEnv = value;
  },
  icon: () => (setting.data.unityEnv === value ? IElSelect : undefined),
});

const { repoMenuItems, handleRepoMenuClose } = useRepoMenuItems({ dialogRef: addRepoSourceDialogRef as any });

const menuConfig = computed(() => {
  const m = messages.value;
  return markRaw<MenuBarConfig>([
    {
      name: m.file,
      items: [
        {
          name: m.loadFile,
          handler: openFile,
          disabled: () => assetManager.isLoading,
        },
        {
          name: m.loadFolder,
          handler: openFolder,
          disabled: () => assetManager.isLoading,
        },
        {
          name: m.batchWorkflow,
          divided: true,
          handler: () => batchWorkflowDialogRef.value?.open(),
        },
      ],
    },
    {
      name: m.options,
      icon: true,
      items: [
        {
          name: m.enablePreview,
          handler: () => {
            setting.data.enablePreview = !setting.data.enablePreview;
          },
          icon: () => (setting.data.enablePreview ? IElSelect : undefined),
        },
        {
          name: m.hideNamelessAssets,
          handler: () => {
            setting.data.hideNamelessAssets = !setting.data.hideNamelessAssets;
          },
          icon: () => (setting.data.hideNamelessAssets ? IElSelect : undefined),
        },
        {
          name: m.exportOptions,
          divided: true,
          disabled: () => assetManager.isBatchExporting,
          handler: () => {
            exportOptionsDialogRef.value?.open();
          },
        },
        {
          name: m.unityCNOptions,
          disabled: () => assetManager.isLoading,
          handler: () => {
            unityCNOptionsDialogRef.value?.open();
          },
        },
      ],
    },
    {
      name: m.env,
      icon: true,
      items: [
        getEnvMenuItem(m.none, BundleEnv.NONE),
        getEnvMenuItem(m.arknights, BundleEnv.ARKNIGHTS, true),
        getEnvMenuItem(m.arknightsEndfield, BundleEnv.ARKNIGHTS_ENDFIELD),
      ],
    },
    {
      name: m.export,
      items: [
        {
          name: m.allAssets,
          handler: () => emits('commandExport', 'all'),
          disabled: () => !assetManager.assetInfos.length,
        },
        {
          name: m.filteredAssets,
          handler: () => emits('commandExport', 'filtered'),
          disabled: () => !assetManager.assetInfos.length,
        },
        {
          name: m.selectedAssets,
          handler: () => emits('commandExport', 'selected'),
          disabled: () => !(assetManager.assetInfos.length && assetManager.curAssetInfo),
        },
        {
          name: m.allDecryptedBundles,
          divided: true,
          handler: () => assetManager.exportAllDecryptedBundles(),
          disabled: () => !assetManager.hasKhBundles,
        },
        {
          name: m.currentDecryptedBundle,
          handler: () => {
            if (assetManager.curAssetInfo) {
              assetManager.exportDecryptedBundle(assetManager.curAssetInfo);
            }
          },
          disabled: () => !assetManager.curAssetInfo || !assetManager.hasKhBundles,
        },
        {
          name: m.allDecompressedBundles,
          divided: true,
          handler: () => assetManager.exportAllDecompressedBundles(),
          disabled: () => !assetManager.hasKhBundles,
        },
        {
          name: m.currentDecompressedBundle,
          handler: () => {
            if (assetManager.curAssetInfo) {
              assetManager.exportDecompressedBundle(assetManager.curAssetInfo);
            }
          },
          disabled: () => !assetManager.curAssetInfo || !assetManager.hasKhBundles,
        },
        {
          name: m.allModifiedBundles,
          divided: true,
          handler: () => assetManager.exportAllModifiedBundles(),
          disabled: () => !assetManager.assetInfos.length,
        },
        {
          name: m.currentModifiedBundle,
          handler: () => {
            if (assetManager.curAssetInfo) {
              assetManager.exportModifiedBundle(assetManager.curAssetInfo);
            }
          },
          disabled: () => !assetManager.curAssetInfo,
        },
        {
          name: `KH: UnityKHFS`,
          divided: true,
          handler: () => { assetManager.khFormat = 'UnityKHFS'; },
        },
        {
          name: `KH: UnityKHNFS`,
          handler: () => { assetManager.khFormat = 'UnityKHNFS'; },
        },
        {
          name: `KH: UnityKH1FS`,
          handler: () => { assetManager.khFormat = 'UnityKH1FS'; },
        },
        {
          name: m.allEncryptedBundles,
          handler: () => assetManager.exportAllEncryptedBundles(),
          disabled: () => !assetManager.assetInfos.length,
        },
        {
          name: m.currentEncryptedBundle,
          handler: () => {
            if (assetManager.curAssetInfo) {
              assetManager.exportEncryptedBundle(assetManager.curAssetInfo);
            }
          },
          disabled: () => !assetManager.curAssetInfo,
        },
      ],
    },
    {
      name: m.repository,
      icon: true,
      items: repoMenuItems,
      onClose: handleRepoMenuClose,
    },
    {
      name: locale.value === 'zh-CN' ? '中文' : 'English',
      icon: true,
      items: [
        {
          name: '中文',
          handler: () => setLocale('zh-CN'),
          icon: () => (locale.value === 'zh-CN' ? IElSelect : undefined),
        },
        {
          name: 'English',
          handler: () => setLocale('en-US'),
          icon: () => (locale.value === 'en-US' ? IElSelect : undefined),
        },
      ],
    },
  ]);
});
</script>

<style lang="scss" scoped>
.menu-btn {
  border: none;
  border-radius: 0;
  outline: none;
}

.github-btn {
  --el-fill-color-light: rgba(0, 0, 0, 0.1);
  --el-fill-color: rgba(0, 0, 0, 0.15);
  padding: 4px;
  font-size: 18px;
}

.theme-btn {
  --el-fill-color-light: rgba(0, 0, 0, 0.1);
  --el-fill-color: rgba(0, 0, 0, 0.15);
  padding: 4px;
  font-size: 18px;
}
</style>
