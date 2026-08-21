<template>
  <div class="texture-editor">
    <div class="toolbar">
      <div class="toolbar-section">
        <el-button-group>
          <el-button :type="tool === 'brush' ? 'primary' : ''" size="small" @click="tool = 'brush'">
            画笔
          </el-button>
          <el-button :type="tool === 'eraser' ? 'primary' : ''" size="small" @click="tool = 'eraser'">
            橡皮
          </el-button>
          <el-button :type="tool === 'fill' ? 'primary' : ''" size="small" @click="tool = 'fill'">
            填充
          </el-button>
        </el-button-group>
        <el-color-picker v-model="brushColor" size="small" show-alpha />
        <el-slider v-model="brushSize" :min="1" :max="64" :step="1" size="small" style="width: 100px" />
      </div>
      <div class="toolbar-section">
        <el-button size="small" @click="handleImportImage">
          导入图片
        </el-button>
        <input ref="fileInput" type="file" accept="image/*" style="display: none" @change="onFileChange" />
      </div>
      <div class="toolbar-section">
        <el-tooltip content="选择抠图模型：RMBG-1.4（ONNX，88MB）/ Removebg 1.6（TF.js，196MB）/ Removebg 1.5 Fast（ONNX，386MB）" placement="top">
          <el-select v-model="bgModelType" size="small" style="width: 160px">
            <el-option label="RMBG-1.4 (ONNX)" value="rmbg" />
            <el-option label="Removebg 1.6 (TF.js)" value="tfjs" />
            <el-option label="Removebg 1.5 Fast (ONNX)" value="fast" />
          </el-select>
        </el-tooltip>
        <el-tooltip
          :content="currentBgRemoval.isModelReady.value ? `对当前画布执行 AI 抠图（${modelName.value}）` : '点击加载抠图模型'"
          placement="top"
        >
          <el-button
            size="small"
            :loading="removeBgProcessing || isModelLoading"
            :type="currentBgRemoval.isModelReady.value ? 'warning' : ''"
            @click="handleRemoveBg"
          >
            {{ currentBgRemoval.isModelReady.value ? '一键抠图' : '初始化抠图模型' }}
          </el-button>
        </el-tooltip>
        <el-tooltip content="点击后到画布上点背景颜色，强制扣掉该颜色（容差内）" placement="top">
          <el-button
            size="small"
            :type="pickingColor ? 'danger' : ''"
            @click="toggleColorPicker"
          >
            {{ pickingColor ? '取色中（点击背景）' : '色度键抠图' }}
          </el-button>
        </el-tooltip>
        <el-tooltip content="色度键颜色容差：数值越大扣得越多" placement="top">
          <span class="param-label">容差</span>
        </el-tooltip>
        <el-input-number
          v-model="colorTolerance"
          :min="1"
          :max="255"
          :step="5"
          size="small"
          style="width: 90px"
        />
      </div>
      <div class="toolbar-section">
        <el-tooltip
          :content="scaleModeOptions.find(o => o.value === scaleMode)?.desc ?? '导入图片尺寸适配模式'"
          placement="top"
        >
          <el-select v-model="scaleMode" size="small" style="width: 110px" placeholder="缩放模式">
            <el-option
              v-for="opt in scaleModeOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
        </el-tooltip>
        <el-tooltip content="缩放算法：双线性更平滑，最近邻保留像素硬边" placement="top">
          <el-select v-model="scaleQuality" size="small" style="width: 100px" placeholder="质量">
            <el-option label="双线性" value="bilinear" />
            <el-option label="最近邻" value="nearest" />
          </el-select>
        </el-tooltip>
        <el-tooltip content="按住对比原始纹理（松开恢复编辑状态）" placement="top">
          <el-button
            size="small"
            :type="comparing ? 'warning' : ''"
            :disabled="!originalTextureImage"
            @mousedown="handleCompareStart"
            @mouseup="handleCompareEnd"
            @mouseleave="handleCompareEnd"
          >
            对比原图
          </el-button>
        </el-tooltip>
      </div>
      <div class="toolbar-section toolbar-settings">
        <el-select v-model="targetFormat" size="small" style="width: 180px" placeholder="输出格式">
          <el-option
            v-for="fmt in supportedFormatOptions"
            :key="fmt.value"
            :label="fmt.label"
            :value="fmt.value"
          />
        </el-select>
        <el-tooltip content="生成 Mipmap 链（关闭则仅写入基础级别）" placement="top">
          <el-checkbox v-model="generateMips" size="small">Mipmaps</el-checkbox>
        </el-tooltip>
        <el-tooltip content="提升清晰度：对发糊边缘做锐化，选择后立即在画布预览，满意再点「应用修改」" placement="top">
          <el-select v-model="sharpenLevel" size="small" style="width: 92px">
            <el-option label="不锐化" :value="0" />
            <el-option label="轻度锐化" :value="1" />
            <el-option label="适中锐化" :value="2" />
            <el-option label="较强锐化" :value="3" />
          </el-select>
        </el-tooltip>
        <el-tooltip content="写回 bundle 的压缩格式：默认不压缩（体积最大但游戏最稳）；LZ4_HC 兼容游戏、体积小。游戏加载器只认 LZ4_HC。" placement="top">
          <el-select v-model="compressionModeModel" size="small" style="width: 118px">
            <el-option label="不压缩" :value="0" />
            <el-option label="LZ4_HC" :value="3" />
            <el-option label="LZ4" :value="2" />
          </el-select>
        </el-tooltip>
        <span class="format-info">{{ currentFormatLabel }}</span>
      </div>
      <div class="toolbar-section">
        <el-button size="small" @click="handleReset">
          重置
        </el-button>
        <el-button type="success" size="small" :loading="applying" @click="handleApply">
          应用修改
        </el-button>
      </div>
    </div>

    <div
      class="canvas-container"
      ref="containerRef"
      :class="{ 'drag-over': isDragOver }"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <canvas
        ref="canvasRef"
        class="editor-canvas"
        :class="{ 'bg-transparent-grid': true, 'picking-color': pickingColor }"
        @mousedown="startDraw"
        @mousemove="draw"
        @mouseup="stopDraw"
        @mouseleave="stopDraw"
        @click="handleClick"
      />
      <div v-if="isDragOver" class="drop-overlay">
        <el-icon class="drop-icon"><Upload /></el-icon>
        <div class="drop-text">松开以导入图片</div>
      </div>
    </div>

    <div v-if="imageInfo" class="image-info">
      <el-text size="small">{{ imageInfo }}</el-text>
    </div>
  </div>
</template>

<script setup lang="ts">
import { TextureFormat } from '@arkntools/unity-js';
import { Upload } from '@element-plus/icons-vue';
import type { AssetInfo } from '@/workers/assetManager';
import { useAssetManager } from '@/store/assetManager';
import { useBackgroundRemoval } from '@/composables/useBackgroundRemoval';
import { useTfjsBgRemoval } from '@/composables/useTfjsBgRemoval';
import { useFastBgRemoval } from '@/composables/useFastBgRemoval';
import { sharpenRgba, SHARPEN_PRESETS } from '@/utils/textureEncoder';

const props = defineProps<{
  asset: AssetInfo;
  data: string | null;
}>();

const assetManager = useAssetManager();
// 抠图 composable 在下方"抠图模型选择"区块统一声明（rmbgRemoval/u2netRemoval/currentBgRemoval）

const canvasRef = ref<HTMLCanvasElement>();
const containerRef = ref<HTMLDivElement>();
const fileInput = ref<HTMLInputElement>();

const tool = ref<'brush' | 'eraser' | 'fill'>('brush');
const brushColor = ref('#FFFFFFFF');
const brushSize = ref(4);
const applying = ref(false);

// === 拖拽导入图片 ===
const isDragOver = ref(false);
// 用计数法防止子元素（canvas、overlay）进出触发 dragleave 闪烁
let dragCounter = 0;

// === 一键抠图 ===
const removeBgProcessing = ref(false);
const isModelLoading = ref(false);

// === 抠图模型选择 ===
type BgModelType = 'rmbg' | 'tfjs' | 'fast';
const bgModelType = ref<BgModelType>('rmbg'); // 默认 RMBG-1.4（无需 token）
const rmbgRemoval = useBackgroundRemoval();
const tfjsRemoval = useTfjsBgRemoval();
const fastRemoval = useFastBgRemoval();
// 当前选中的抠图 composable
const currentBgRemoval = computed(() => {
  if (bgModelType.value === 'tfjs') return tfjsRemoval;
  if (bgModelType.value === 'fast') return fastRemoval;
  return rmbgRemoval;
});
const modelName = computed(() => {
  if (bgModelType.value === 'tfjs') return 'Removebg 1.6';
  if (bgModelType.value === 'fast') return 'Removebg 1.5 Fast';
  return 'RMBG-1.4';
});

// === 色度键抠图（点画布取色强制扣掉） ===
const pickingColor = ref(false);
const colorTolerance = ref(30);

const isDrawing = ref(false);
const lastPos = ref({ x: 0, y: 0 });
const originalImageData = ref<ImageData | null>(null);
const imageInfo = ref('');

// === 锐化（实时预览，确认后再应用） ===
// sharpenLevel：0=关闭，1=轻度，2=适中，3=较强。调整后立即在画布预览，
// 「应用修改」写入的即是所见内容（不再二次锐化）。
const sharpenLevel = ref<number>(0);
// 未锐化基准：每次加载/编辑操作后固化的画布快照，切换强度时从它重新计算
let sharpenBase: ImageData | null = null;

/** 按当前强度把锐化结果应用到画布预览（level=0 恢复基准） */
const applySharpenPreview = () => {
  const ctx = getCtx();
  if (!ctx || !sharpenBase) return;
  const level = sharpenLevel.value;
  if (level <= 0) {
    ctx.putImageData(sharpenBase, 0, 0);
    return;
  }
  const preset = SHARPEN_PRESETS[level];
  if (!preset) return;
  const data = sharpenRgba(
    new Uint8Array(sharpenBase.data),
    sharpenBase.width,
    sharpenBase.height,
    preset,
  );
  // ImageData 构造要求 Uint8ClampedArray（sharpenRgba 返回 Uint8Array，需转换）
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), sharpenBase.width, sharpenBase.height), 0, 0);
};

/** 把当前画布内容固化为锐化基准（编辑操作完成后调用）；
 *  withPreview=true 时立即按当前强度重新应用锐化预览（编辑后的新内容直接显示锐化效果） */
const captureSharpenBase = (withPreview = true) => {
  const ctx = getCtx();
  const canvas = canvasRef.value;
  if (!ctx || !canvas || canvas.width === 0 || canvas.height === 0) return;
  sharpenBase = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (withPreview) applySharpenPreview();
};

/** 编辑操作开始前调用：把画布恢复到未锐化基准，保证操作（画笔/抠图/取色）基于原始内容，
 *  避免在已锐化的显示上继续编辑造成累积锐化 */
const restoreSharpenBase = () => {
  if (sharpenLevel.value <= 0) return;
  const ctx = getCtx();
  if (!ctx || !sharpenBase) return;
  ctx.putImageData(sharpenBase, 0, 0);
};

watch(sharpenLevel, () => applySharpenPreview());
const hasEdits = ref(false);

// === 导入图片尺寸适配 ===
type ScaleMode = 'auto' | 'contain' | 'stretch' | 'cover';
type ScaleQuality = 'bilinear' | 'nearest';

const scaleMode = ref<ScaleMode>('auto');
const scaleQuality = ref<ScaleQuality>('bilinear');
// 1:1 对比预览：按住按钮时显示原始纹理图，松开恢复当前编辑状态
const comparing = ref(false);
// 缓存原始纹理的 ImageData，用于对比预览
const originalTextureImage = ref<ImageData | null>(null);
// 最近一次导入的缩放信息
const lastScaleInfo = ref<{ from: string; to: string; mode: ScaleMode } | null>(null);

const scaleModeOptions: Array<{ value: ScaleMode; label: string; desc: string }> = [
  { value: 'auto', label: '智能', desc: '宽高比接近时拉伸，差异大时等比填充' },
  { value: 'contain', label: '等比填充', desc: '保留宽高比，空白透明填充' },
  { value: 'stretch', label: '拉伸', desc: '直接拉伸到原始尺寸，可能变形' },
  { value: 'cover', label: '裁剪填充', desc: '等比缩放后裁剪超出部分' },
];

const resolveAutoMode = (srcW: number, srcH: number, dstW: number, dstH: number): ScaleMode => {
  if (!srcW || !srcH || !dstW || !dstH) return 'contain';
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;
  // 宽高比差异 < 5% 视为接近，用拉伸避免留白
  return Math.abs(srcRatio - dstRatio) / Math.max(srcRatio, dstRatio) < 0.05 ? 'stretch' : 'contain';
};

/**
 * 将图片缩放绘制到目标尺寸的 canvas
 * - contain: 等比缩放使图片完全包含，剩余透明
 * - stretch: 直接拉伸
 * - cover: 等比缩放覆盖，超出部分由 canvas 边界自动裁剪
 */
const drawImageScaled = (
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  mode: ScaleMode,
  quality: ScaleQuality,
): void => {
  ctx.clearRect(0, 0, dstW, dstH);
  ctx.imageSmoothingEnabled = quality === 'bilinear';
  if (quality === 'bilinear') {
    ctx.imageSmoothingQuality = 'high';
  }

  if (mode === 'stretch') {
    // 直接铺满
    ctx.drawImage(img, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
    return;
  }

  const scale = mode === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const dw = Math.round(srcW * scale);
  const dh = Math.round(srcH * scale);
  const dx = Math.round((dstW - dw) / 2);
  const dy = Math.round((dstH - dh) / 2);
  // cover 模式下 dx/dy 可能为负，超出 canvas 的部分自动被裁剪
  ctx.drawImage(img, 0, 0, srcW, srcH, dx, dy, dw, dh);
};

const formatScaleInfo = (info: { from: string; to: string; mode: ScaleMode } | null): string => {
  if (!info) return '';
  if (info.from === info.to) return '';
  const modeLabel = scaleModeOptions.find(o => o.value === info.mode)?.label ?? info.mode;
  return ` · 缩放 ${info.from}→${info.to} (${modeLabel})`;
};

const preview = computed(() => props.asset.preview as any);
const originalFormat = computed<number>(() => preview.value.textureFormat ?? TextureFormat.RGBA32);
const originalWidth = computed<number>(() => preview.value.width ?? 0);
const originalHeight = computed<number>(() => preview.value.height ?? 0);

const supportedFormats = computed<number[]>(() => preview.value.supportedFormats ?? []);
const supportedFormatOptions = computed(() => {
  const allFormats: Array<{ value: number; label: string }> = [];
  for (const fmt of supportedFormats.value) {
    allFormats.push({ value: fmt, label: TextureFormat[fmt] ?? `Format ${fmt}` });
  }
  return allFormats;
});

// 默认使用 RGBA32（无损纹理，游戏实测可进），Mipmaps 默认关闭以避免大块格式进一步降质
const targetFormat = ref<number>(TextureFormat.RGBA32);
const generateMips = ref(false);

/** 写回压缩模式（0=不压缩 默认 | 2=LZ4 | 3=LZ4_HC），选择即同步到全局 + worker */
const compressionModeModel = computed({
  get: () => assetManager.compressionMode,
  set: (v: number) => {
    assetManager.setCompressionMode(v);
  },
});

const formatLabel = (fmt: number) => TextureFormat[fmt] ?? `Format ${fmt}`;
const currentFormatLabel = computed(() => {
  if (targetFormat.value === originalFormat.value) {
    return `原始格式: ${formatLabel(originalFormat.value)}`;
  }
  return `${formatLabel(originalFormat.value)} → ${formatLabel(targetFormat.value)}`;
});

const getCtx = () => canvasRef.value?.getContext('2d', { willReadFrequently: true });

const cssColorToRgba = (css: string) => {
  if (css.startsWith('#')) {
    let hex = css.slice(1);
    if (hex.length === 6) hex += 'FF';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = parseInt(hex.slice(6, 8), 16);
    return [r, g, b, a];
  }
  return [255, 255, 255, 255];
};

const loadImageToCanvas = async (url: string, isImport = false) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = url;
  });

  const canvas = canvasRef.value!;
  const ctx = getCtx()!;
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  if (isImport) {
    const dstW = originalWidth.value || srcW;
    const dstH = originalHeight.value || srcH;
    // 解析实际缩放模式（auto → contain/stretch）
    const actualMode: ScaleMode =
      scaleMode.value === 'auto' ? resolveAutoMode(srcW, srcH, dstW, dstH) : scaleMode.value;

    canvas.width = dstW;
    canvas.height = dstH;
    drawImageScaled(ctx, img, srcW, srcH, dstW, dstH, actualMode, scaleQuality.value);
    hasEdits.value = true;

    lastScaleInfo.value =
      srcW === dstW && srcH === dstH
        ? null
        : { from: `${srcW}×${srcH}`, to: `${dstW}×${dstH}`, mode: actualMode };
    imageInfo.value = `${dstW}×${dstH}${formatScaleInfo(lastScaleInfo.value)}`;
  } else {
    // 加载原始纹理：canvas 尺寸即为原始尺寸
    canvas.width = srcW;
    canvas.height = srcH;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    originalImageData.value = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // 缓存原始纹理图用于 1:1 对比预览
    originalTextureImage.value = ctx.getImageData(0, 0, canvas.width, canvas.height);
    hasEdits.value = false;
    lastScaleInfo.value = null;
    imageInfo.value = `${srcW}×${srcH}`;
  }
  // 新图从原始清晰度看起：重置锐化强度并固化基准
  sharpenLevel.value = 0;
  captureSharpenBase();
};

watch(
  () => props.data,
  url => {
    if (url) loadImageToCanvas(url);
  },
  { immediate: true },
);

const getCanvasPos = (e: MouseEvent) => {
  const canvas = canvasRef.value!;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.floor((e.clientX - rect.left) * scaleX),
    y: Math.floor((e.clientY - rect.top) * scaleY),
  };
};

const setPixel = (ctx: CanvasRenderingContext2D, x: number, y: number, color: number[], size: number) => {
  const r = Math.floor(size / 2);
  const imgData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  const data = imgData.data;
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      if (size > 2 && dx * dx + dy * dy > r * r) continue;
      const idx = (py * w + px) * 4;
      if (tool.value === 'eraser') {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
      } else {
        data[idx] = color[0];
        data[idx + 1] = color[1];
        data[idx + 2] = color[2];
        data[idx + 3] = color[3];
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
};

const drawLine = (fromX: number, fromY: number, toX: number, toY: number) => {
  const ctx = getCtx()!;
  const color = cssColorToRgba(brushColor.value);
  const dx = Math.abs(toX - fromX);
  const dy = Math.abs(toY - fromY);
  const sx = fromX < toX ? 1 : -1;
  const sy = fromY < toY ? 1 : -1;
  let err = dx - dy;
  let x = fromX;
  let y = fromY;
  while (true) {
    setPixel(ctx, x, y, color, brushSize.value);
    if (x === toX && y === toY) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
};

const startDraw = (e: MouseEvent) => {
  if (tool.value === 'fill') return;
  restoreSharpenBase(); // 编辑前回到未锐化内容
  isDrawing.value = true;
  lastPos.value = getCanvasPos(e);
  drawLine(lastPos.value.x, lastPos.value.y, lastPos.value.x, lastPos.value.y);
};

const draw = (e: MouseEvent) => {
  if (!isDrawing.value || tool.value === 'fill') return;
  const pos = getCanvasPos(e);
  drawLine(lastPos.value.x, lastPos.value.y, pos.x, pos.y);
  lastPos.value = pos;
  hasEdits.value = true;
};

const stopDraw = () => {
  isDrawing.value = false;
  // 画笔操作完成：把结果固化为锐化基准（后续切强度从新内容计算）
  captureSharpenBase();
};

const floodFill = (ctx: CanvasRenderingContext2D, startX: number, startY: number, fillColor: number[]) => {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const startIdx = (startY * w + startX) * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];
  const targetA = data[startIdx + 3];
  if (targetR === fillColor[0] && targetG === fillColor[1] && targetB === fillColor[2] && targetA === fillColor[3]) return;

  const stack: [number, number][] = [[startX, startY]];
  const matches = (idx: number) =>
    data[idx] === targetR && data[idx + 1] === targetG && data[idx + 2] === targetB && data[idx + 3] === targetA;

  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || x >= w || y < 0 || y >= h) continue;
    const idx = (y * w + x) * 4;
    if (!matches(idx)) continue;
    data[idx] = fillColor[0];
    data[idx + 1] = fillColor[1];
    data[idx + 2] = fillColor[2];
    data[idx + 3] = fillColor[3];
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  ctx.putImageData(imgData, 0, 0);
};

const handleClick = (e: MouseEvent) => {
  // 色度键取色模式优先：点画布取色并扣掉该颜色
  if (pickingColor.value) {
    handlePickAndRemoveColor(e);
    return;
  }
  if (tool.value !== 'fill') return;
  restoreSharpenBase(); // 填充前回到未锐化内容
  const ctx = getCtx();
  if (!ctx) return;
  const pos = getCanvasPos(e);
  const color = cssColorToRgba(brushColor.value);
  floodFill(ctx, pos.x, pos.y, color);
  hasEdits.value = true;
  captureSharpenBase();
};

// === 色度键抠图 ===
const toggleColorPicker = () => {
  pickingColor.value = !pickingColor.value;
};

/**
 * 取色并扣掉容差范围内的颜色
 * 对纯色背景（白底/绿幕等）100% 有效，作为 AI 抠图的兜底
 */
const handlePickAndRemoveColor = (e: MouseEvent) => {
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx) return;
  restoreSharpenBase(); // 取色抠图前回到未锐化内容（取色基于原始像素）
  const pos = getCanvasPos(e);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const w = canvas.width;
  const h = canvas.height;
  // 取点击位置的颜色（取 3x3 平均避免单像素噪声）
  const sx = Math.max(0, pos.x - 1);
  const sy = Math.max(0, pos.y - 1);
  const ex = Math.min(w - 1, pos.x + 1);
  const ey = Math.min(h - 1, pos.y + 1);
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = sy; y <= ey; y++) {
    for (let x = sx; x <= ex; x++) {
      const idx = (y * w + x) * 4;
      r += data[idx];
      g += data[idx + 1];
      b += data[idx + 2];
      count++;
    }
  }
  r = Math.round(r / count);
  g = Math.round(g / count);
  b = Math.round(b / count);
  const tol = colorTolerance.value;
  const tolSq = tol * tol;
  // 扣掉容差范围内的像素
  let removed = 0;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - r;
    const dg = data[i + 1] - g;
    const db = data[i + 2] - b;
    if (dr * dr + dg * dg + db * db <= tolSq) {
      data[i + 3] = 0;
      removed++;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  hasEdits.value = true;
  pickingColor.value = false;
  ElMessage.success(`已扣掉颜色 rgb(${r},${g},${b})，共 ${removed} 像素`);
  captureSharpenBase();
};

const handleImportImage = () => {
  fileInput.value?.click();
};

/**
 * 通用图片导入逻辑（点击选择和拖拽放下共用）
 */
const importImageFile = (file: File) => {
  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择或拖入图片文件');
    return;
  }
  const url = URL.createObjectURL(file);
  loadImageToCanvas(url, true).finally(() => {
    URL.revokeObjectURL(url);
  });
};

const onFileChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importImageFile(file);
  input.value = '';
};

// === 拖拽导入：拖到画布编辑区域自动导入 ===
// 用 dragCounter 计数法解决子元素进出导致的抖动/闪烁
const handleDragOver = (e: DragEvent) => {
  // 仅当拖入文件时计数（排除拖入文本/节点等）
  if (!e.dataTransfer?.types?.includes('Files')) return;
  dragCounter++;
  if (dragCounter === 1) isDragOver.value = true;
};

const handleDragLeave = () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) isDragOver.value = false;
};

const handleDrop = (e: DragEvent) => {
  dragCounter = 0;
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  importImageFile(file);
};

// === 一键抠图：对当前画布执行 AI 背景移除 ===
const handleRemoveBg = async () => {
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx) return;
  restoreSharpenBase(); // 抠图前回到未锐化内容（模型输入应为原始像素）

  const removal = currentBgRemoval.value;

  // 模型未就绪：先初始化
  if (!removal.isModelReady.value) {
    if (isModelLoading.value) return;
    isModelLoading.value = true;
    try {
      const sizeHint = bgModelType.value === 'tfjs'
        ? '本地加载约 196MB（TF.js 通用模型，需已部署到 public/models/removebg-1.6/）'
        : bgModelType.value === 'fast'
          ? '本地加载约 386MB（ONNX 快速模型，需已部署到 public/models/removebg-1.5/fast/）'
          : '需下载约 88MB';
      ElMessage.info(`正在加载抠图模型（${modelName.value}，${sizeHint}）...`);
      await removal.init();
      ElMessage.success(`${modelName.value} 模型已就绪，再次点击执行抠图`);
      applySharpenPreview(); // 恢复锐化预览（加载期间画布被恢复为未锐化）
      return;
    } catch (e) {
      console.error('[RMBG] 模型加载失败:', e);
      ElMessage.error(`模型加载失败: ${e}`);
      applySharpenPreview(); // 失败也恢复预览
      return;
    } finally {
      isModelLoading.value = false;
    }
  }

  removeBgProcessing.value = true;
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // RMBG-1.4：用 threshold/feather/softAlpha 后处理 mask
    // Removebg 1.6：输出已是完整 RGBA（模型精修过），threshold=0 保留原始输出
    // Removebg 1.5 Fast：输出 salience map，需 threshold/feather 后处理
    const opts: any =
      bgModelType.value === 'tfjs'
        ? { threshold: 0, feather: false, softAlpha: true }
        : bgModelType.value === 'fast'
          ? { threshold: 64, feather: true, softAlpha: true }
          : { threshold: 64, feather: true, softAlpha: true, maxProcessSize: 1024 };
    const result = await removal.removeBackground(imgData, opts);
    ctx.putImageData(result, 0, 0);
    hasEdits.value = true;
    ElMessage.success(`${modelName.value} 抠图完成（如仍有残留，可用"色度键抠图"兜底）`);
    captureSharpenBase();
  } catch (e) {
    ElMessage.error(`抠图失败: ${e}`);
  } finally {
    removeBgProcessing.value = false;
  }
};

// === 绿背抠图功能已移除（效果不明显，保留色度键抠图作为兜底） ===


const handleReset = () => {
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx || !originalImageData.value) return;
  canvas.width = originalImageData.value.width;
  canvas.height = originalImageData.value.height;
  ctx.putImageData(originalImageData.value, 0, 0);
  hasEdits.value = false;
  targetFormat.value = TextureFormat.RGBA32;
  generateMips.value = false;
  lastScaleInfo.value = null;
  imageInfo.value = `${canvas.width}×${canvas.height}`;
  sharpenLevel.value = 0; // 重置：回到原始清晰度
  captureSharpenBase();
};

// 1:1 对比预览：按住按钮时显示原始纹理，松开恢复当前编辑状态
let compareSnapshot: ImageData | null = null;
const handleCompareStart = () => {
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx || !originalTextureImage.value) return;
  // 保存当前画布状态
  compareSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // 切换到原始纹理尺寸并显示
  canvas.width = originalTextureImage.value.width;
  canvas.height = originalTextureImage.value.height;
  ctx.putImageData(originalTextureImage.value, 0, 0);
  comparing.value = true;
};

const handleCompareEnd = () => {
  if (!comparing.value || !compareSnapshot) return;
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx) return;
  // 恢复编辑状态
  canvas.width = compareSnapshot.width;
  canvas.height = compareSnapshot.height;
  ctx.putImageData(compareSnapshot, 0, 0);
  compareSnapshot = null;
  comparing.value = false;
};

const handleApply = async () => {
  const canvas = canvasRef.value;
  const ctx = getCtx();
  if (!canvas || !ctx) return;

  const asset = props.asset;
  const fmt = targetFormat.value;

  applying.value = true;
  try {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgbaBuffer = new ArrayBuffer(imgData.data.length);
    new Uint8Array(rgbaBuffer).set(imgData.data);

    const ok = await assetManager.modifyTexture2D(
      asset.fileId,
      asset.pathId,
      new Uint8Array(rgbaBuffer),
      canvas.width,
      canvas.height,
      fmt,
      generateMips.value,
      false, // 画布已包含锐化预览结果，worker 不再二次锐化
    );
    if (ok) {
      originalImageData.value = ctx.getImageData(0, 0, canvas.width, canvas.height);
      hasEdits.value = false;
    }
  } finally {
    applying.value = false;
  }
};

defineExpose({ hasEdits });
</script>

<style lang="scss" scoped>
.texture-editor {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.toolbar {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  padding: 6px 8px;
  gap: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 拖拽导入：画布容器作为拖放区，拖入时整体高亮 */
.canvas-container.drag-over {
  background-color: var(--el-color-success-light-9);
  outline: 2px dashed var(--el-color-success);
  outline-offset: -2px;
}

/* 拖放遮罩：覆盖在画布上，pointer-events:none 避免干扰 dragleave */
.drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  pointer-events: none;
  background-color: rgba(255, 255, 255, 0.6);
  z-index: 10;
}
.drop-icon {
  font-size: 64px;
  color: var(--el-color-success);
}
.drop-text {
  font-size: 18px;
  font-weight: 500;
  color: var(--el-color-success-dark-2);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
}

.toolbar-settings {
  gap: 8px;
  flex: 1;
  min-width: 200px;
}

.format-info {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.canvas-container {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  position: relative;
}

.editor-canvas {
  max-width: 100%;
  max-height: 100%;
  image-rendering: pixelated;
  image-rendering: -moz-crisp-edges;
  image-rendering: crisp-edges;
  cursor: crosshair;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

/* 色度键取色模式：画布显示十字光标提示 */
.editor-canvas.picking-color {
  cursor: crosshair;
  outline: 2px dashed var(--el-color-danger);
  outline-offset: 2px;
}

.param-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.image-info {
  position: absolute;
  bottom: 4px;
  left: 8px;
  pointer-events: none;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.3);
}
</style>
