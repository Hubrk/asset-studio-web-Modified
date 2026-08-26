export enum PreviewType {
  None,
  Text,
  Image,
  ImageList,
  Spine,
  Audio,
  FrameAnimation,
  FsbBank,
}

/** FSB5 bank 内单个子音频的元数据（仅供预览列表展示，解码走 FMOD） */
export interface FsbSampleMeta {
  /** 在 bank 中的子音频下标 */
  index: number;
  /** 样本名（FSB5 name table，缺失时为 sample_<index>） */
  name: string;
  /** 声道数 */
  channels: number;
  /** 采样率 Hz */
  frequency: number;
  /** 时长（秒）= sampleCount / frequency */
  duration: number;
  /** PCM 帧数 */
  sampleCount: number;
  /** 编码格式 hint（FSB5 mode 字段，0=PCM 15=Vorbis 等） */
  mode: number;
}

/** FSB5 bank 预览：列出全部子音频，逐个播放 */
export interface PreviewFsbBankDetail {
  type: PreviewType.FsbBank;
  samples: FsbSampleMeta[];
}

/**
 * 帧动画预览的「完整图集」视图标记。
 * 作为 previewPayload 传给 worker 时，表示请求整张图集（而非某个切片帧）。
 * 对 Texture2D 图集，默认显示整图；选具体动画组时才逐帧加载切片。
 */
export const WHOLE_ATLAS_PAYLOAD = '__whole_atlas__';

export interface PreviewImageDetail {
  type: PreviewType.Image;
  textureFormat?: number;
  width?: number;
  height?: number;
  canEdit?: boolean;
  supportedFormats?: number[];
}

export interface PreviewTextDetail {
  type: PreviewType.Text;
  canEdit?: boolean;
  /** TextAsset 数据是否为 KFB 加密容器（00 0e / 00 0f 开头），是则 Edit tab 走 KFB 战斗逻辑编辑器 */
  kfbContainer?: boolean;
  /** TextAsset 数据是否为 protobuf 二进制（aininjadata 配置），是则 Edit tab 走 Protobuf 查看器 */
  protoContainer?: boolean;
}

export interface PreviewImageListDetailItem {
  key: string;
  name: string;
}

export interface PreviewImageListDetail {
  type: PreviewType.ImageList;
  detail: PreviewImageListDetailItem[];
}

/** 切片在图集中的像素矩形（unity-js 的 Sprite.rect） */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 一帧的分块（tile）偏移信息。
 * 当 Sprite 被切成多块（如 _A/_B/_C）时，每块在统一画布上的位置。
 * 坐标系：画布左上角为原点，y 向下（与 Canvas/图片一致）。
 */
export interface FrameTileOffset {
  /** 该 tile 对应的 Sprite pathId（用于 worker 取图） */
  key: string;
  /** Sprite 完整名（如 "idle_0knn1_0000_A"） */
  name: string;
  /** 在合成画布上的左上角 x（像素，四舍五入） */
  px: number;
  /** 在合成画布上的左上角 y（像素，四舍五入） */
  py: number;
  /** 该 tile 自身像素宽 */
  w: number;
  /** 该 tile 自身像素高 */
  h: number;
}

/** 一帧（带其在图集中的位置矩形 + 可选的合成分块信息） */
export interface FrameAnimationFrame extends PreviewImageListDetailItem {
  rect?: FrameRect;
  /** 合成画布尺寸（仅多 tile 帧有值） */
  canvasW?: number;
  canvasH?: number;
  /** 该帧包含的分块列表（单 tile 帧为空数组或 undefined） */
  tiles?: FrameTileOffset[];
}

/** 一个动画（来自同一图集、按名字前缀分组的连续帧序列） */
export interface FrameAnimationGroup {
  /** 动画名（去掉末尾帧号后的前缀，如 "attack_1_1nrtcmb00"） */
  name: string;
  /** 帧数 */
  frameCount: number;
  /** 按帧号升序排列的帧列表 */
  frames: FrameAnimationFrame[];
}

/**
 * 序列帧动画预览。
 * 适用于「一张 Texture2D 图集 + 多个 Sprite 子图」的资产：
 * 每个 Sprite 自带 rect 位置信息（unity-js 内部按 rect 裁出单帧），
 * 按名字前缀把同源 Sprite 分成多个动画，可逐一播放。
 */
export interface PreviewFrameAnimationDetail {
  type: PreviewType.FrameAnimation;
  /** 所属图集 Texture2D 名称 */
  atlasName: string;
  /** 图集像素尺寸（坐标上下文，可选） */
  atlasWidth?: number;
  atlasHeight?: number;
  /** 所有可播放动画（仅含 >=2 帧的分组） */
  groups: FrameAnimationGroup[];
  /** 默认选中的动画名（Sprite 级预览时指向其所属分组；Texture2D 级预览时为首组） */
  defaultGroup?: string;
  /** 底层图集 Texture2D 的纹理格式（EDIT 页切换输出格式用，可选） */
  textureFormat?: number;
  /** 图集像素宽/高（EDIT 页尺寸校验/自适应用，可选） */
  width?: number;
  height?: number;
  /** 是否可编辑（图集格式受编码器支持），可选 */
  canEdit?: boolean;
  /** 支持的编码格式列表（EDIT 页输出格式下拉，可选） */
  supportedFormats?: number[];
}

export type PreviewDetail =
  | { type: Exclude<PreviewType, PreviewType.Image | PreviewType.ImageList | PreviewType.Text | PreviewType.FrameAnimation | PreviewType.FsbBank> }
  | PreviewImageDetail
  | PreviewTextDetail
  | PreviewImageListDetail
  | PreviewFrameAnimationDetail
  | PreviewFsbBankDetail;
