import { isArrayBuffer, isTypedArray } from 'es-toolkit';

export const isData = (data: unknown) => isArrayBuffer(data) || isTypedArray(data) || data instanceof DataView;

/** 裸位图文件类型检测（PNG/JPEG/WebP）；不是位图返回 null */
export type RawImageType = 'png' | 'jpg' | 'webp';

export const detectRawImage = (bytes: Uint8Array): RawImageType | null => {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
};

/** 按文件名后缀推断图片 MIME（导出/预览 Blob 用） */
export const imageMimeOf = (name: string): string => {
  const ext = (name.toLowerCase().split('.').pop() || '').replace(/[^a-z0-9]/g, '');
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
};
