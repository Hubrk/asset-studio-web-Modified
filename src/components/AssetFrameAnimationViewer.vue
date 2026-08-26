<template>
  <div class="asset-frame-anim-viewer">
    <el-splitter>
      <el-splitter-panel v-if="imgList.length" v-model:size="menuWidth" :min="100" class="asset-frame-anim-panel">
        <el-scrollbar class="menu-scroll-view">
          <el-menu ref="menu" @select="handleSelect">
            <el-menu-item
              v-for="(item, idx) in imgList"
              :key="item.key"
              :index="item.key"
              :class="{ 'is-current-frame': idx === currentFrameIndex }"
            >
              <span class="img-name">{{ item.name }}</span>
              <span class="frame-index">{{ idx + 1 }}</span>
            </el-menu-item>
          </el-menu>
        </el-scrollbar>
      </el-splitter-panel>
      <el-splitter-panel :min="200" class="asset-frame-anim-panel">
        <div class="viewer-wrap">
          <!-- 顶部：图集名 + 动画选择 -->
          <div class="anim-toolbar">
            <span class="atlas-name" :title="atlasName">{{ atlasName }}</span>
            <el-select
              v-model="selectedGroup"
              size="small"
              class="group-select"
              placeholder="选择动画"
            >
              <el-option
                :label="`完整图集${fa.atlasWidth ? ` (${fa.atlasWidth}×${fa.atlasHeight})` : ''}`"
                :value="WHOLE"
              />
              <el-option
                v-for="g in groups"
                :key="g.name"
                :label="`${g.name} (${g.frameCount})`"
                :value="g.name"
              />
            </el-select>
            <el-dropdown
              split-button
              type="primary"
              size="small"
              :disabled="!groups.length"
              @click="exportCoords('current')"
              @command="exportCoords"
            >
              导出坐标
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="current" :disabled="!currentGroup">
                    当前动画（{{ currentGroup?.name ?? '' }}）
                  </el-dropdown-item>
                  <el-dropdown-item command="all">
                    全部动画（{{ groups.length }} 个）
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>

          <ImageViewer :src="data" :name="name" />

          <!-- 序列帧播放控制条 -->
          <div v-if="isPlayable" class="sprite-player">
            <div class="player-left">
              <el-button-group size="small">
                <el-tooltip content="跳到第一帧 (Home)" placement="top">
                  <el-button @click="goToFrame(0)" :disabled="currentFrameIndex === 0">
                    <el-icon><i-el-d-arrow-left /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip content="上一帧 (←)" placement="top">
                  <el-button @click="prevFrame" :disabled="currentFrameIndex === 0">
                    <el-icon><i-el-arrow-left /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip :content="isPlaying ? '暂停 (Space)' : '播放 (Space)'" placement="top">
                  <el-button :type="isPlaying ? 'warning' : 'primary'" @click="togglePlay">
                    <el-icon>
                      <i-el-video-pause v-if="isPlaying" />
                      <i-el-video-play v-else />
                    </el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip content="下一帧 (→)" placement="top">
                  <el-button @click="nextFrame" :disabled="currentFrameIndex === totalFrames - 1 && !loop">
                    <el-icon><i-el-arrow-right /></el-icon>
                  </el-button>
                </el-tooltip>
                <el-tooltip content="跳到最后一帧 (End)" placement="top">
                  <el-button @click="goToFrame(totalFrames - 1)" :disabled="currentFrameIndex === totalFrames - 1">
                    <el-icon><i-el-d-arrow-right /></el-icon>
                  </el-button>
                </el-tooltip>
              </el-button-group>
              <el-divider direction="vertical" />
              <el-tooltip content="循环播放" placement="top">
                <el-checkbox v-model="loop" size="small">循环</el-checkbox>
              </el-tooltip>
            </div>
            <div class="player-center">
              <span class="frame-counter">{{ currentFrameIndex + 1 }} / {{ totalFrames }}</span>
              <el-slider
                v-model="currentFrameIndex"
                :min="0"
                :max="totalFrames - 1"
                :step="1"
                :show-tooltip="false"
                size="small"
                class="frame-slider"
                @input="onSliderInput"
                @change="onSliderChange"
              />
            </div>
            <div class="player-right">
              <span class="fps-label">FPS</span>
              <el-input-number
                v-model="fps"
                :min="1"
                :max="60"
                :step="1"
                size="small"
                :controls="true"
                style="width: 80px"
              />
            </div>
          </div>
        </div>
      </el-splitter-panel>
    </el-splitter>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, computed, watch } from 'vue';
import { useLocalStorage } from '@vueuse/core';
import ImageViewer from '@/components/ImageViewer.vue';
import { PreviewType, WHOLE_ATLAS_PAYLOAD } from '@/types/preview';
import type { PreviewFrameAnimationDetail, FrameAnimationFrame } from '@/types/preview';
import type { AssetInfo } from '@/workers/assetManager';

/** 「完整图集」视图标记 */
const WHOLE = WHOLE_ATLAS_PAYLOAD;

defineOptions({ name: 'AssetFrameAnimationViewer' });

const { asset, data } = defineProps<{
  asset: AssetInfo;
  data: string | null;
}>();

const emits = defineEmits<{
  updatePayload: [key?: string];
}>();

const menuRef = useTemplateRef('menu');

const menuWidth = useLocalStorage('asset-frame-anim-menu-width', 220, {
  writeDefaults: false,
  listenToStorageChanges: false,
});

const fa = computed(() => asset.preview as PreviewFrameAnimationDetail);
const atlasName = computed(() => fa.value.atlasName || asset.name);
const groups = computed(() => fa.value.groups || []);

// 是否为「整张图集」资产（Texture2D 图集默认显示整图，而非直接进动画）
const isAtlasTexture = computed(() => asset.type === 'Texture2D');

// 当前选中的动画组；Texture2D 图集默认「完整图集」，Sprite 默认其所属分组
const selectedGroup = ref<string>(
  isAtlasTexture.value ? WHOLE : (fa.value.defaultGroup || groups.value[0]?.name || ''),
);

// 当前组的帧列表（作为播放序列）
const imgList = computed(() => {
  const g = groups.value.find((x) => x.name === selectedGroup.value);
  return g ? g.frames : [];
});
const imgMap = computed(() => new Map(imgList.value.map((item) => [item.key, item])));

// 当前选中的动画组（导出坐标用）
const currentGroup = computed(() => groups.value.find((g) => g.name === selectedGroup.value));

// ── 一键导出切片坐标（dump 每个 Sprite 在图集中的 rect）──
function frameToCoord(f: FrameAnimationFrame) {
  if (!f.rect) return null;
  return { name: f.name, x: Math.round(f.rect.x), y: Math.round(f.rect.y), w: Math.round(f.rect.w), h: Math.round(f.rect.h) };
}

function buildGroupPayload(g: (typeof groups.value)[number]) {
  return {
    atlas: atlasName.value,
    atlasWidth: fa.value.atlasWidth ?? null,
    atlasHeight: fa.value.atlasHeight ?? null,
    group: g.name,
    frameCount: g.frameCount,
    frames: g.frames.map(frameToCoord),
  };
}

function buildAllPayload() {
  return {
    atlas: atlasName.value,
    atlasWidth: fa.value.atlasWidth ?? null,
    atlasHeight: fa.value.atlasHeight ?? null,
    groupCount: groups.value.length,
    groups: groups.value.map((g) => ({
      name: g.name,
      frameCount: g.frameCount,
      frames: g.frames.map(frameToCoord),
    })),
  };
}

function triggerDownload(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function exportCoords(scope: 'current' | 'all') {
  if (!groups.value.length) return;
  const g = currentGroup.value;
  if (scope === 'current' && !g) return;
  const payload = scope === 'current' ? buildGroupPayload(g!) : buildAllPayload();
  const text = JSON.stringify(payload, null, 2);
  const base = (atlasName.value || 'frame_anim').replace(/[^\w.-]+/g, '_');
  const suffix = scope === 'current' ? (g!.name || 'group') : 'all';
  const filename = `${base}_${suffix}_coords.json`;
  triggerDownload(filename, text);
  const ok = await copyText(text);
  ElMessage({
    message: ok ? `已下载并复制坐标：${filename}` : `已下载坐标：${filename}`,
    type: 'success',
  });
}

const curSelectKey = ref<string>('');
const curSelectItem = computed(() => imgMap.value.get(curSelectKey.value));
const name = computed(() => (imgList.value.length ? curSelectItem.value?.name : asset.name));

// ── 序列帧播放状态 ──
const isPlaying = ref(false);
const loop = ref(true);
const fps = ref(12);
const currentFrameIndex = ref(0);

let animFrameId: number | null = null;
let lastFrameTime = 0;

// ── 播放控制（必须在 watch 之前定义，避免 TDZ）──
const togglePlay = () => {
  if (isPlaying.value) stopPlayback();
  else startPlayback();
};

const startPlayback = () => {
  if (totalFrames.value < 2) return;
  isPlaying.value = true;
  lastFrameTime = performance.now();
  animFrameId = requestAnimationFrame(tick);
};

const stopPlayback = () => {
  isPlaying.value = false;
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
};

const tick = (now: number) => {
  if (!isPlaying.value) return;
  const interval = 1000 / fps.value;
  const elapsed = now - lastFrameTime;
  if (elapsed >= interval) {
    lastFrameTime = now - (elapsed % interval);
    if (currentFrameIndex.value >= totalFrames.value - 1) {
      if (loop.value) currentFrameIndex.value = 0;
      else {
        stopPlayback();
        return;
      }
    } else {
      currentFrameIndex.value++;
    }
  }
  animFrameId = requestAnimationFrame(tick);
};

const prevFrame = () => {
  stopPlayback();
  if (currentFrameIndex.value > 0) currentFrameIndex.value--;
};

const nextFrame = () => {
  stopPlayback();
  if (currentFrameIndex.value < totalFrames.value - 1) currentFrameIndex.value++;
  else if (loop.value) currentFrameIndex.value = 0;
};

const goToFrame = (idx: number) => {
  stopPlayback();
  currentFrameIndex.value = Math.max(0, Math.min(idx, totalFrames.value - 1));
};

/** el-slider 的 input/change 事件参数可能是 number 或 number[]（范围模式），单值取第一个 */
const toSingle = (val: number | number[]) => (Array.isArray(val) ? val[0] ?? 0 : val);
const onSliderInput = (val: number | number[]) => {
  currentFrameIndex.value = toSingle(val);
};
const onSliderChange = (val: number | number[]) => {
  currentFrameIndex.value = toSingle(val);
};

const onKeyDown = (e: KeyboardEvent) => {
  if (!isPlayable.value) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      prevFrame();
      break;
    case 'ArrowRight':
      e.preventDefault();
      nextFrame();
      break;
    case 'Home':
      e.preventDefault();
      goToFrame(0);
      break;
    case 'End':
      e.preventDefault();
      goToFrame(totalFrames.value - 1);
      break;
  }
};

const isPlayable = computed(() => imgList.value.length >= 2);
const totalFrames = computed(() => imgList.value.length);

// 切换动画组：重置到首帧并发起首帧加载
watch(
  selectedGroup,
  () => {
    stopPlayback();
    currentFrameIndex.value = 0;
    // 完整图集视图：请求整张图，不进入播放
    if (selectedGroup.value === WHOLE) {
      curSelectKey.value = '';
      emits('updatePayload', WHOLE);
      return;
    }
    const first = imgList.value[0];
    if (first) {
      curSelectKey.value = first.key;
      emits('updatePayload', first.key);
    }
  },
  { immediate: true },
);

// 播放游标变化 -> 请求对应帧图像（父级按 key 懒加载）
watch(currentFrameIndex, (idx) => {
  const item = imgList.value[idx];
  if (item) {
    curSelectKey.value = item.key;
    emits('updatePayload', item.key);
  }
});

// 侧栏选择
const handleSelect = (key: string) => {
  const idx = imgList.value.findIndex((item) => item.key === key);
  if (idx >= 0) goToFrame(idx);
};

// 组件卸载清理
onUnmounted(() => {
  stopPlayback();
  window.removeEventListener('keydown', onKeyDown);
});

// 键盘监听（聚焦时生效）
watch(isPlayable, (playable) => {
  if (playable) window.addEventListener('keydown', onKeyDown);
  else window.removeEventListener('keydown', onKeyDown);
});
</script>

<style lang="scss" scoped>
.asset-frame-anim-viewer {
  width: 100%;
  height: 100%;
}

.viewer-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  position: relative;
}

.anim-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  .atlas-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--el-text-color-primary);
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-select {
    width: 280px;
  }
}

// 复用 AssetImageViewer 的播放条/侧栏样式（保持一致视觉）
.sprite-player {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--el-bg-color-overlay);
  border-top: 1px solid var(--el-border-color-lighter);
}

.player-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.player-center {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}

.player-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.frame-counter {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  min-width: 48px;
  text-align: center;
}

.frame-slider {
  flex: 1;
}

.fps-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.menu-scroll-view {
  height: 100%;
}

.img-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.frame-index {
  margin-left: 8px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.is-current-frame {
  background: var(--el-color-primary-light-9);
}
</style>
