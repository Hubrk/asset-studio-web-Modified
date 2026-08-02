export enum PreviewType {
  None,
  Text,
  Image,
  ImageList,
  Spine,
  Audio,
}

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
}

export interface PreviewImageListDetailItem {
  key: string;
  name: string;
}

export interface PreviewImageListDetail {
  type: PreviewType.ImageList;
  detail: PreviewImageListDetailItem[];
}

export type PreviewDetail =
  | { type: Exclude<PreviewType, PreviewType.Image | PreviewType.ImageList | PreviewType.Text> }
  | PreviewImageDetail
  | PreviewTextDetail
  | PreviewImageListDetail;
