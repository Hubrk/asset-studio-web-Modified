/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="unplugin-icons/types/vue3" />
/// <reference types="vite-svg-loader" />
/// <reference types="@types/wicg-file-system-access" />

declare module 'lz4js' {
  export function compressBound(n: number): number;
  export function compressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    hashTable: Uint32Array,
  ): number;
  export function decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ): number;
  export function compress(src: Uint8Array, maxSize?: number): Uint8Array;
  export function decompress(src: Uint8Array, maxSize?: number): Uint8Array;
}

// fmod 音频适配：node-web-audio-api 仅 Node 后端可用，前端（browser）不安装此包。
// 提供宽松类型垫片，使 fmod/window.ts 的类型检查通过（运行时前端不使用）。
declare module 'node-web-audio-api' {
  const _default: any;
  export = _default;
}

// aes-js 无内置类型声明，提供宽松垫片（仅本项目用到 ModeOfOperation.ecb）
declare module 'aes-js' {
  export const ModeOfOperation: any;
}
