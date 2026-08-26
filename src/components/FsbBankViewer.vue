<template>
  <div class="fsb-bank-viewer">
    <div class="bank-header">
      <div class="bank-title">
        <el-icon class="bank-icon"><Headset /></el-icon>
        <span>FSB Bank · {{ samples.length }} 个音频</span>
      </div>
      <div class="bank-actions">
        <span v-if="replacedCount > 0" class="replaced-hint">已替换 {{ replacedCount }} 个</span>
        <el-button
          size="small"
          type="primary"
          :loading="exporting"
          @click="onExport"
        >
          <el-icon v-if="!exporting"><Download /></el-icon>
          {{ exporting ? '导出中…' : exportLabel }}
        </el-button>
      </div>
    </div>

    <div class="bank-hint">
      点每行右侧「替换」或直接把音频文件拖到该行，即可替换该样本（支持即时试听）；全部改完后点右上角「导出 bank」生成重打包文件。单独子音频也能在左侧资产列表以 Audio 类型播放 / 导出 WAV。
    </div>

    <div class="sample-list">
      <div
        v-for="(s, i) in samples"
        :key="s.index"
        class="sample-row"
        :class="{ 'drag-over': dragOverIndex === i }"
        @dragover.prevent="onRowDragOver(i, $event)"
        @dragleave="onRowDragLeave(i, $event)"
        @drop.prevent.stop="onRowDrop(i, $event)"
      >
        <div v-if="dragOverIndex === i" class="row-drop-hint">
          <el-icon><Upload /></el-icon>
          <span>松开以替换「{{ s.name }}」</span>
        </div>
        <div class="sample-main">
          <button class="play-btn" :class="{ playing: isPlaying(i) }" @click="toggle(i)" :title="loading[i] ? '解码中…' : '播放'">
            <el-icon v-if="loading[i]"><Loading class="is-loading" /></el-icon>
            <el-icon v-else-if="isPlaying(i)"><VideoPause /></el-icon>
            <el-icon v-else><VideoPlay /></el-icon>
          </button>
          <div class="sample-info">
            <div class="sample-name" :title="s.name">{{ s.name }}</div>
            <div class="sample-tags">
              <span class="tag">{{ codecName(s.mode) }}</span>
              <span class="tag">{{ s.channels === 1 ? '单声道' : s.channels + ' 声道' }}</span>
              <span class="tag">{{ s.frequency }} Hz</span>
              <span class="tag">{{ formatDuration(s.duration) }}</span>
              <span v-if="isReplaced(i)" class="tag replaced">已替换</span>
            </div>
          </div>
          <button class="replace-btn" title="用本地音频替换该样本" @click="pickReplace(i)">
            <el-icon><Refresh /></el-icon>
            <span>替换</span>
          </button>
          <div class="sample-index">#{{ s.index }}</div>
        </div>
        <audio
          v-if="urls[i]"
          ref="audioEls"
          :src="urls[i]"
          class="sample-audio"
          controls
          @play="onPlay(i)"
          @pause="onPause(i)"
          @ended="onPause(i)"
        />
      </div>
    </div>

    <!-- 隐藏的替换文件选择器（所有行共用，靠 replacingIndex 区分） -->
    <input
      ref="fileInput"
      type="file"
      accept="audio/*"
      style="display: none"
      @change="onReplaceFile"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { Loading, Headset, VideoPlay, VideoPause, Download, Refresh, Upload } from '@element-plus/icons-vue';
import { useAssetManager } from '@/store/assetManager';
import { decodeAudioFileToPcm, pcmToWavBlob } from '@/utils/audioDecode';
import type { AssetInfo } from '@/workers/assetManager';
import type { FsbSampleMeta } from '@/types/preview';

const props = defineProps<{
  asset: AssetInfo;
  data: string | null;
}>();

const assetManager = useAssetManager();

const samples = computed<FsbSampleMeta[]>(() => (props.asset.preview as any).samples ?? []);
const totalDuration = computed(() => samples.value.reduce((sum, s) => sum + (s.duration || 0), 0));

const isContainer = computed(() => /\.(bank|fsb|fsb5)$/i.test(props.asset.fileName));
const exportLabel = computed(() => (isContainer.value ? '导出 bank' : '导出 FSB5'));

const urls = reactive<Record<number, string>>({});
const loading = reactive<Record<number, boolean>>({});
const playing = reactive<Record<number, boolean>>({});
const replacedKeys = reactive<Set<number>>(new Set());
const audioEls = ref<(HTMLAudioElement | null)[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const replacingIndex = ref(-1);
const exporting = ref(false);
const dragOverIndex = ref(-1);

const replacedCount = computed(() => replacedKeys.size);
const isReplaced = (i: number) => replacedKeys.has(i);

const CODEC_NAMES: Record<number, string> = {
  0: 'PCM',
  1: 'PCM',
  2: 'ADPCM',
  3: 'MP3',
  4: 'PSMVAG',
  5: 'HEVAG',
  6: 'XMA',
  7: 'AAC',
  8: 'GCADPCM',
  9: 'ATRAC9',
  15: 'Vorbis',
};
const codecName = (mode: number) => CODEC_NAMES[mode] ?? `mode ${mode}`;

const formatDuration = (sec: number) => {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const isPlaying = (i: number) => playing[i] === true;
const onPlay = (i: number) => (playing[i] = true);
const onPause = (i: number) => (playing[i] = false);

const toggle = async (i: number) => {
  const el = audioEls.value[i];
  if (el && !el.paused) {
    el.pause();
    return;
  }
  // 已替换样本：urls[i] 在替换时已生成为本地 WAV，直接播放
  if (!urls[i]) {
    loading[i] = true;
    try {
      const url = await assetManager.loadPreviewData({
        fileId: props.asset.fileId,
        pathId: BigInt(samples.value[i].index),
      } as unknown as AssetInfo);
      if (url) urls[i] = url;
    } catch (e) {
      console.error('[FsbBankViewer] 解码失败', e);
    } finally {
      loading[i] = false;
    }
  }
  const after = audioEls.value[i];
  if (after && urls[i]) {
    try {
      await after.play();
    } catch (e) {
      console.error('[FsbBankViewer] 播放失败', e);
    }
  }
};

const pickReplace = (i: number) => {
  replacingIndex.value = i;
  fileInput.value?.click();
};

// 文件 → 解码 → 替换第 i 个样本（按钮选择与拖放共用）
const replaceWithFile = async (i: number, file: File) => {
  try {
    const { pcm, channels, sampleRate } = await decodeAudioFileToPcm(file);
    // 本地即时试听：生成 WAV URL
    if (urls[i]) URL.revokeObjectURL(urls[i]);
    urls[i] = URL.createObjectURL(pcmToWavBlob(pcm, channels, sampleRate));
    // 交给 worker 记录替换（用于导出重打包）
    await assetManager.replaceFsbSample(props.asset.fileId, i, pcm, channels, sampleRate);
    replacedKeys.add(i);
    // 无需弹 toast：行上的「已替换」标签已提供视觉反馈
  } catch (e) {
    console.error('[FsbBankViewer] 替换解码失败', e);
    ElMessage({ message: `替换失败：${e}`, type: 'error' });
  }
};

const onReplaceFile = async (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  const i = replacingIndex.value;
  input.value = ''; // 允许重复选择同一文件
  replacingIndex.value = -1;
  if (!file || i < 0) return;
  await replaceWithFile(i, file);
};

// 逐行拖放替换：拖文件到某行即替换对应样本
const onRowDragOver = (_i: number, e: DragEvent) => {
  // 必须 preventDefault 才能触发 drop
  e.preventDefault();
  dragOverIndex.value = _i;
};

const onRowDragLeave = (i: number, e: DragEvent) => {
  // 仅当真正离开整行（而非移入行内子元素）时才取消高亮
  const related = e.relatedTarget as Node | null;
  const current = e.currentTarget as HTMLElement | null;
  if (!current || !current.contains(related)) dragOverIndex.value = -1;
};

const onRowDrop = async (i: number, e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation(); // 避免冒泡到任何全局 drop 处理器
  dragOverIndex.value = -1;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  await replaceWithFile(i, file);
};

const onExport = async () => {
  exporting.value = true;
  try {
    await assetManager.exportFsbBank(props.asset);
  } finally {
    exporting.value = false;
  }
};

onUnmounted(() => {
  Object.values(urls).forEach((u) => u && URL.revokeObjectURL(u));
});
</script>

<style lang="scss" scoped>
.fsb-bank-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: linear-gradient(160deg, #1b1f2a 0%, #14171f 100%);
  color: #e6e8ee;
  overflow: hidden;
}

.bank-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.bank-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;

  .bank-icon {
    color: var(--el-color-primary);
    font-size: 18px;
  }
}

.bank-actions {
  display: flex;
  align-items: center;
  gap: 10px;

  .replaced-hint {
    font-size: 12px;
    color: #7fd1a0;
  }
}

.bank-meta {
  font-size: 12px;
  color: #9aa3b2;
}

.sample-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sample-row {
  position: relative;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 8px 10px;
  transition: background 0.18s ease, transform 0.18s ease, border-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    background: rgba(255, 255, 255, 0.07);
    transform: translateY(-1px);
  }

  // 拖放替换时的高亮态
  &.drag-over {
    border-color: var(--el-color-primary);
    background: rgba(var(--el-color-primary-rgb), 0.14);
    box-shadow: 0 0 0 2px rgba(var(--el-color-primary-rgb), 0.35) inset;
    transform: translateY(-1px);
  }
}

.row-drop-hint {
  position: absolute;
  inset: 0;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: rgba(var(--el-color-primary-rgb), 0.22);
  backdrop-filter: blur(1px);
  pointer-events: none;
  z-index: 2;

  .el-icon {
    font-size: 16px;
  }
}

.sample-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.play-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: var(--el-color-primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;

  &:hover {
    transform: scale(1.08);
    box-shadow: 0 4px 14px rgba(var(--el-color-primary-rgb), 0.4);
  }

  &.playing {
    background: #e8574f;
  }
}

.bank-hint {
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.5;
  color: #9aa3b2;
  background: rgba(255, 255, 255, 0.02);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.replace-btn {
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  gap: 4px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #c6cede;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

  &:hover {
    background: rgba(var(--el-color-primary-rgb), 0.18);
    border-color: rgba(var(--el-color-primary-rgb), 0.5);
    color: #fff;
  }
}

.sample-info {
  flex: 1;
  min-width: 0;
}

.sample-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sample-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: #b8c0d0;

  &.replaced {
    background: rgba(127, 209, 160, 0.18);
    color: #7fd1a0;
  }
}

.sample-index {
  flex-shrink: 0;
  font-size: 11px;
  color: #6f7889;
  font-variant-numeric: tabular-nums;
}

.sample-audio {
  width: 100%;
  margin-top: 8px;
  height: 34px;
}

.is-loading {
  animation: fsb-spin 1s linear infinite;
}

@keyframes fsb-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
