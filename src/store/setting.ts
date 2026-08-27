import { BundleEnv } from '@arkntools/unity-js';
import { useLocalStorage } from '@vueuse/core';
import { pick } from 'es-toolkit';
import { defineStore } from 'pinia';
import { ExportGroupMethod } from '@/types/export';

export enum FsbConvertFormat {
  WAV = 'wav',
  MP3 = 'mp3',
}

/** 资产导出目标：目录选择器（桌面端）或 ZIP 打包下载（Web/PWA 端均可用） */
export enum ExportTarget {
  DIRECTORY = 'directory',
  ZIP = 'zip',
}

/** 导出重名文件时的去重后缀风格：name (2).png 或 name_2.png */
export type ExportRenameStyle = 'paren' | 'underscore';

export interface Settings {
  enablePreview: boolean;
  hideNamelessAssets: boolean;
  exportGroupMethod: ExportGroupMethod;
  exportTarget: ExportTarget;
  /** 导出重名文件时的去重后缀风格 */
  exportRenameStyle: ExportRenameStyle;
  /** 批量 bundle zip 内条目是否加处理类型后缀（如 foo_encrypted.assetbundle） */
  exportZipSuffix: boolean;
  unityCNKeyEnabled: boolean;
  unityCNKey: string;
  unityEnv: BundleEnv;
  fsbConvertFormat: FsbConvertFormat;
  fsbConvertVbrQuality: number;
}

export const useSetting = defineStore('setting', () => {
  const data = useLocalStorage<Settings>(
    'settings',
    {
      enablePreview: true,
      hideNamelessAssets: true,
      exportGroupMethod: ExportGroupMethod.NONE,
      exportTarget: ExportTarget.DIRECTORY,
      exportRenameStyle: 'paren',
      exportZipSuffix: false,
      unityCNKeyEnabled: false,
      unityCNKey: '',
      unityEnv: BundleEnv.ARKNIGHTS,
      fsbConvertFormat: FsbConvertFormat.MP3,
      fsbConvertVbrQuality: 0,
    },
    {
      writeDefaults: false,
      mergeDefaults: (storageValue, defaults) => ({
        ...defaults,
        ...pick(storageValue, Object.keys(defaults) as any),
      }),
    },
  );

  return {
    data,
    unityCNKey: computed(() => (data.value.unityCNKeyEnabled ? data.value.unityCNKey || undefined : undefined)),
  };
});
