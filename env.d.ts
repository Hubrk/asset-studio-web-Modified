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
