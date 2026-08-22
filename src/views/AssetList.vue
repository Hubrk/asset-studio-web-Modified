<template>
  <div class="asset-list-table-wrapper">
    <div class="asset-list-table-header">
      <SearchInput ref="searchInputRef" />
      <el-tooltip :content="messages.multiSelect" placement="bottom">
        <el-button
          :type="isMultiSelect ? 'primary' : 'default'"
          size="small"
          :icon="isMultiSelect ? IElCircleCheckFilled : IElCircleCheck"
          class="multi-select-btn"
          @click="toggleMultiSelect"
        />
      </el-tooltip>
    </div>
    <div class="asset-list-table-main" @dragover.capture.prevent @drop.capture.prevent="handleDropFiles">
      <vxe-table
        id="asset-list-table"
        ref="tableRef"
        class="asset-list-table"
        :data="searchedAssetInfos"
        :loading="store.isLoading"
        :border="true"
        size="mini"
        height="100%"
        header-cell-class-name="cursor-pointer"
        :row-class-name="
          ({ row }) => ({
            highlight: row.key === highlightRowKey,
            // fix highlight current row bug
            'row--current': row.key === store.curAssetInfo?.key,
          })
        "
        :row-config="{
          useKey: true,
          keyField: 'key',
          isCurrent: true,
          isHover: true,
        }"
        :column-config="{ resizable: true }"
        :menu-config="menuConfig"
        :keyboard-config="{ isArrow: true }"
        :checkbox-config="
          isMultiSelect ? { trigger: 'row', highlight: true, range: true, isShiftKey: true } : undefined
        "
        :custom-config="{ storage: { visible: true, resizable: true } }"
        :scroll-y="{ enabled: true }"
        show-overflow="title"
        show-header-overflow
        @menu-click="handleMenu"
        @header-cell-menu="handleHeaderCellMenu"
        @cell-menu="handleCellMenu"
        @cell-click="handleCellClick"
        @current-change="handleCurrentChange"
        @header-cell-click="handleHeaderCellClick"
        @checkbox-range-end="updateMultiSelectNum"
        @checkbox-all="updateMultiSelectNum"
        @checkbox-change="handleCheckboxChange"
        @keydown="handleKeyDown"
      >
        <vxe-column
          v-if="isMultiSelect"
          type="checkbox"
          :width="38"
          :resizable="false"
          fixed="left"
          header-class-name="cell-overflow-visible"
          class-name="cell-overflow-visible"
        />
        <vxe-column field="name" title="Name" fixed="left" :min-width="120" sortable :sort-by="sortNameMethod" />
        <vxe-column field="fileName" title="From file" :min-width="60" sortable />
        <vxe-column field="container" title="Container" :min-width="60" sortable />
        <vxe-column field="type" title="Type" :width="110" sortable :filters="typeFilterOptions" />
        <vxe-column field="pathId" title="PathID" :min-width="60" />
        <vxe-column field="size" title="Size" align="right" header-align="left" :width="85" sortable>
          <template #default="{ row }">
            {{ formatSize(row.size) }}
          </template>
        </vxe-column>
        <template #empty>
          <el-text :style="{ fontSize: '30px', color: 'var(--el-color-info-light-3)' }">
            {{ filteredAssetInfos.length ? 'No data' : 'Drop files here or click "File" menu to load files' }}
          </el-text>
        </template>
      </vxe-table>
    </div>
    <div v-if="isMultiSelect" class="asset-list-table-footer wrap">
      <div class="footer-block desc">
        {{ multiSelectNum }} 个资产，来自 {{ selectedFileCount }} 个文件{{
          multiSelectCannotExportNum > 0 ? `，${multiSelectCannotExportNum} 个无法导出` : ''
        }}。
      </div>
      <div class="footer-block actions">
        <el-button
          type="primary"
          size="small"
          :disabled="store.isBatchExporting || multiSelectNum === multiSelectCannotExportNum"
          @click="handleBatchExportSelected"
          >导出资产</el-button
        >
        <el-button
          v-if="hasKhFileSelected"
          type="primary"
          size="small"
          :disabled="store.isBatchExporting"
          @click="handleBatchExportDecrypted"
          >{{ messages.exportDecrypted }}</el-button
        >
        <el-button
          type="primary"
          size="small"
          :disabled="store.isBatchExporting"
          @click="handleBatchExportEncrypted"
          >{{ messages.exportEncrypted }}</el-button
        >
        <el-button type="primary" size="small" @click="handleCancelMultiSelect">取消</el-button>
      </div>
    </div>
    <div v-if="showProgressBar" class="asset-list-table-footer">
      <ProgressBar />
    </div>
  </div>
</template>

<script setup lang="ts">
import { identity } from 'es-toolkit';
import type { VxeColumnPropTypes, VxeTableEvents, VxeTableInstance, VxeTablePropTypes } from 'vxe-table';
import SearchInput from '@/components/SearchInput.vue';
import { useNatsort } from '@/hooks/useNatsort';
import { useRefDebouncedConditional } from '@/hooks/useRef';
import { useAssetManager } from '@/store/assetManager';
import { useSetting } from '@/store/setting';
import { useLocale } from '@/composables/useLocale';
import { getKeysFromEvent, sleep } from '@/utils/common';
import { getFilesFromDataTransferItems } from '@/utils/file';
import { formatSize } from '@/utils/formater';
import { showNotingCanBeExportToast } from '@/utils/toasts';
import {
  getKeyDownHandler,
  getMenuHeaderConfig,
  getVxeTableCommonTools,
  handleCommonMenu,
} from '@/utils/vxeTableCommon';
import type { AssetInfo } from '@/workers/assetManager';
import IElCircleCheck from '~icons/ep/circle-check';
import IElCircleCheckFilled from '~icons/ep/circle-check-filled';
import ProgressBar from './components/ProgressBar.vue';

const tableRef = ref<VxeTableInstance<AssetInfo>>();

const store = useAssetManager();
const setting = useSetting();
const { messages } = useLocale();

watch(
  () => store.curAssetInfo,
  info => {
    if (!info) tableRef.value?.clearCurrentRow();
  },
);

const handleDropFiles = async (e: DragEvent) => {
  if (store.isLoading) return;
  const items = [...(e.dataTransfer?.items ?? [])];
  const files = await getFilesFromDataTransferItems(items);
  if (files.length) store.loadFiles(files);
};

const filteredAssetInfos = computed(() =>
  setting.data.hideNamelessAssets ? store.assetInfos.filter(({ name }) => name) : store.assetInfos,
);

const showProgressBar = useRefDebouncedConditional({
  source: computed(() => store.isLoading || store.isBatchExporting),
  delay: 300,
  condition: identity,
});

const searchInputRef = useTemplateRef('searchInputRef');

const searchValueGetter = (item: AssetInfo) => item.search;
const searchedAssetInfos = computed(
  () => searchInputRef.value?.doSearch(filteredAssetInfos.value, searchValueGetter) || filteredAssetInfos.value,
);

const getAssetNameSortIndex = useNatsort(() => store.assetInfos.map(({ name }) => name));
const sortNameMethod: VxeColumnPropTypes.SortBy<AssetInfo> = ({ row }) => getAssetNameSortIndex(row.name);

const isMultiSelect = ref(false);
const multiSelectRows = shallowRef<AssetInfo[]>([]);
const multiSelectNum = computed(() => multiSelectRows.value.length);
const multiSelectCannotExportNum = computed(() => multiSelectRows.value.filter(row => !store.canExport(row)).length);

let lastAssetInfo: AssetInfo | undefined;

const updateMultiSelectNum = () => {
  multiSelectRows.value = tableRef.value!.getCheckboxRecords();
};

const handleKeyDown = getKeyDownHandler({
  onCheckAll: () => {
    isMultiSelect.value = true;
    updateMultiSelectNum();
  },
});

const handleCellClick: VxeTableEvents.CellClick<AssetInfo> = async ({ row, $event }) => {
  const { modKey, shiftKey } = getKeysFromEvent($event);
  const $table = tableRef.value!;
  let lastRowIndex: number;
  if (
    (modKey || shiftKey) &&
    !isMultiSelect.value &&
    lastAssetInfo &&
    (lastRowIndex = $table.getVTRowIndex(lastAssetInfo)) >= 0
  ) {
    const rowIndex = $table.getVTRowIndex(row);
    isMultiSelect.value = true;
    if (shiftKey) {
      const { visibleData } = $table.getTableData();
      await $table.setCheckboxRow(
        visibleData.slice(Math.min(lastRowIndex, rowIndex), Math.max(lastRowIndex, rowIndex) + 1),
        true,
      );
    } else if (modKey) {
      await $table.setCheckboxRow([lastAssetInfo, row], true);
    }
  }
  if (isMultiSelect.value) updateMultiSelectNum();
};

const handleCancelMultiSelect = () => {
  tableRef.value?.clearCheckboxRow();
  isMultiSelect.value = false;
  multiSelectRows.value = [];
};

let isBatchSelecting = false;

const handleCheckboxChange: VxeTableEvents.CheckboxChange<AssetInfo> = async ({ row }) => {
  if (!isMultiSelect.value || isBatchSelecting) return;
  isBatchSelecting = true;
  try {
    const $table = tableRef.value!;
    const fileId = row.fileId;
    const isChecked = (($table as any).isCheckboxRowByKey?.(row.key) as boolean | undefined) ?? false;
    const { visibleData } = $table.getTableData();
    const otherSameFile = visibleData.filter(r => r.fileId === fileId && r.key !== row.key);
    if (otherSameFile.length) {
      await $table.setCheckboxRow(otherSameFile, isChecked);
    }
  } finally {
    isBatchSelecting = false;
    updateMultiSelectNum();
  }
};

const toggleMultiSelect = () => {
  if (isMultiSelect.value) {
    handleCancelMultiSelect();
  } else {
    isMultiSelect.value = true;
  }
};

const selectedFileCount = computed(() => {
  if (!multiSelectRows.value.length) return 0;
  return new Set(multiSelectRows.value.map(r => r.fileId)).size;
});

const hasKhFileSelected = computed(() => {
  if (!multiSelectRows.value.length) return false;
  const selectedFileIds = new Set(multiSelectRows.value.map(r => r.fileId));
  return [...selectedFileIds].some(fid => store.khBundleFileIds.has(fid));
});

const handleBatchExportDecrypted = () => {
  const fileIds = new Set(multiSelectRows.value.map(r => r.fileId));
  const khFileIds = [...fileIds].filter(fid => store.khBundleFileIds.has(fid));
  if (!khFileIds.length) {
    ElMessage({ message: '选中的文件均不是加密格式', type: 'warning' });
    return;
  }
  store.exportBundlesByFileIds(khFileIds, 'decrypted');
  handleCancelMultiSelect();
};

const handleBatchExportEncrypted = () => {
  const fileIds = new Set(multiSelectRows.value.map(r => r.fileId));
  store.exportBundlesByFileIds(fileIds, 'encrypted');
  handleCancelMultiSelect();
};

const setCurrentRow = (row: AssetInfo) => {
  if (!tableRef.value) return;
  lastAssetInfo = store.curAssetInfo;
  tableRef.value.setCurrentRow(row);
  store.setCurAssetInfo(row);
};

const typeFilterOptions = computed(() =>
  [...new Set(filteredAssetInfos.value.map(({ type }) => type)).values()]
    .sort()
    .map(value => ({ label: value, value })),
);

const { handleHeaderCellClick, menuConfigVisibleMethodProcessHeader } = getVxeTableCommonTools(tableRef);

const menuConfig = computed<VxeTablePropTypes.MenuConfig<AssetInfo>>(() => ({
  header: getMenuHeaderConfig(),
  body: {
    options: [
      [
        { code: 'export', name: 'Export select asset', prefixIcon: 'vxe-icon-save', disabled: false },
        {
          code: 'exportEncrypted',
          name: messages.value.encryptAndExport,
          prefixIcon: 'vxe-icon-lock',
          disabled: false,
        },
        {
          code: 'exportDecrypted',
          name: messages.value.decryptAndExport,
          prefixIcon: 'vxe-icon-unlock',
          disabled: false,
        },
        {
          code: 'exportModified',
          name: 'Export modified file',
          prefixIcon: 'vxe-icon-save',
          disabled: false,
        },
        {
          code: 'editTexture',
          name: messages.value.editTexture,
          prefixIcon: 'vxe-icon-edit',
          disabled: false,
        },
        { code: 'copyRow', name: 'Copy row text', prefixIcon: 'vxe-icon-copy' },
        { code: 'copy', name: 'Copy cell text', prefixIcon: 'vxe-icon-copy' },
      ],
      [
        { code: 'multiselect', name: 'Multi select', prefixIcon: 'vxe-icon-square-checked' },
        { code: 'selectAll', name: 'Select all', prefixIcon: 'vxe-icon-square-checked' },
      ],
    ],
  },
  visibleMethod: params => {
    const { type, options, column, row } = params;
    if (type === 'header') {
      if (column?.type === 'checkbox') return false;
      menuConfigVisibleMethodProcessHeader(params);
      return true;
    }
    if (isMultiSelect.value || !row) return false;
    options[0][0].disabled = !store.canExport(row);
    // "Encrypt & export" works on any loaded UnityFS bundle (KH or plain).
    options[0][1].disabled = false;
    // "Decrypt & export" works on any loaded UnityFS bundle.
    options[0][2].disabled = false;
    // "Export modified file" always available.
    options[0][3].disabled = false;
    // "Edit texture" only for Texture2D with supported format.
    options[0][4].disabled = !(row.preview as any)?.canEdit;
    return true;
  },
}));

const handleMenu: VxeTableEvents.MenuClick<AssetInfo> = async params => {
  const { menu, row, $table } = params;
  switch (menu.code) {
    case 'export':
      await store.exportAsset(row);
      break;
    case 'exportEncrypted':
      await store.exportEncryptedBundle(row);
      break;
    case 'exportDecrypted':
      await store.exportDecryptedBundle(row);
      break;
    case 'editTexture':
      store.setCurAssetInfo(row);
      store.pendingEditTab = true;
      break;
    case 'exportModified':
      store.exportModifiedBundle(row);
      break;
    case 'copyRow': {
      // 复制所有可见列的全部文本（$table 已从 params 解构）
      const columns = $table.getTableColumn().fullColumn.filter((c) => c.visible !== false && c.field);
      const texts = columns.map((c) => `${c.title || c.field}: ${(row as unknown as Record<string, unknown>)[c.field as string]}`);
      navigator.clipboard.writeText(texts.join('\n'));
      break;
    }
    case 'multiselect':
      isMultiSelect.value = true;
      await $table.setCheckboxRow(row, true);
      updateMultiSelectNum();
      break;
    case 'selectAll':
      isMultiSelect.value = true;
      await $table.setAllCheckboxRow(true);
      updateMultiSelectNum();
      break;
    default:
      handleCommonMenu(params);
      break;
  }
};

const handleHeaderCellMenu: VxeTableEvents.HeaderCellMenu<AssetInfo> = ({ column, $event }) => {
  if (column.type === 'checkbox') $event.preventDefault();
};

const handleCellMenu: VxeTableEvents.CellMenu<AssetInfo> = ({ row, $event }) => {
  if (isMultiSelect.value) {
    $event.preventDefault();
    return;
  }
  setCurrentRow(row);
};

const handleCurrentChange: VxeTableEvents.CurrentChange<AssetInfo> = ({ row }) => {
  lastAssetInfo = store.curAssetInfo;
  store.setCurAssetInfo(row);
};

const handleBatchExportSelected = () => {
  if (!tableRef.value || store.isBatchExporting || !isMultiSelect.value) return false;
  const canExportRows = multiSelectRows.value.filter(store.canExport);
  if (!canExportRows.length) {
    showNotingCanBeExportToast();
    return true;
  }
  store.batchExportAsset(canExportRows);
  handleCancelMultiSelect();
  return true;
};

const highlightRowKey = ref('');
let highlightTimer: NodeJS.Timeout | null = null;

const gotoAsset = async (key: string) => {
  const $table = tableRef.value;
  if (!$table) return;

  const info = $table.getRowById(key);
  if (!info) {
    ElMessage({
      message: `Unable to find asset with key ${key}`,
      type: 'error',
      grouping: true,
    });
    return;
  }

  if ($table.isActiveFilterByColumn(null)) await $table.clearFilter();
  if (searchInputRef.value?.search) {
    searchInputRef.value.clear();
    await sleep();
    await sleep();
  }

  await $table.scrollToRow(info);

  if (highlightTimer) clearTimeout(highlightTimer);
  if (highlightRowKey.value === key) {
    highlightRowKey.value = '';
    await sleep();
  }
  highlightRowKey.value = key;
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    highlightRowKey.value = '';
  }, 1.5e3);
};

const doExport = (type: string) => {
  switch (type) {
    case 'all':
      if (store.assetInfos.length) {
        store.exportAllAssets();
        return;
      }
      break;
    case 'selected':
      if (handleBatchExportSelected()) return;
      if (store.curAssetInfo) {
        store.exportAsset(store.curAssetInfo);
        return;
      }
      break;
    case 'filtered': {
      const { visibleData } = tableRef.value?.getTableData() || {};
      const canExportRows = visibleData?.filter(store.canExport);
      if (canExportRows?.length) {
        store.batchExportAsset(canExportRows);
        return;
      }
      break;
    }
  }
  showNotingCanBeExportToast();
};

if (import.meta.env.DEV) {
  const name = import.meta.env.VITE_AUTO_LOAD_AB;
  if (name) {
    onMounted(async () => {
      const r = await fetch(`/ab/${name}`);
      const data = await r.arrayBuffer();
      const file = new File([data], name);
      await store.loadFiles([file]);
    });
  }
  onBeforeUnmount(() => {
    store.clearFiles();
  });
}

defineExpose({
  gotoAsset,
  doExport,
});
</script>

<style lang="scss" scoped>
.asset-list-table {
  :deep(.highlight) {
    animation: highlight-animation 1.5s;

    @keyframes highlight-animation {
      0%,
      33%,
      66%,
      100% {
        background-color: transparent;
      }
      16%,
      49%,
      82% {
        background-color: var(--el-color-warning-light-3);
      }
    }
  }

  &-wrapper {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  &-main {
    flex-grow: 1;
    flex-shrink: 1;
    min-height: 0;
    overflow: visible;
    z-index: 0;
  }

  &-header {
    flex-shrink: 0;
    margin-bottom: -1px;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .multi-select-btn {
    flex-shrink: 0;
  }

  &-footer {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    padding: 8px 16px;
    font-size: 14px;
    background-color: var(--el-color-info-light-9);

    &.wrap {
      flex-wrap: wrap;
    }

    .footer-block {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      line-height: 24px;
    }

    .desc {
      white-space: nowrap;
    }

    .actions {
      margin-left: auto;
    }
  }
}
</style>
