/// <reference types="vitest" />
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import Vue from '@vitejs/plugin-vue';
import { VxeResolver } from '@vxecli/import-unplugin-vue-components';
import AutoImport from 'unplugin-auto-import/vite';
import IconsResolver from 'unplugin-icons/resolver';
import Icons from 'unplugin-icons/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import Components from 'unplugin-vue-components/vite';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { VitePWA } from 'vite-plugin-pwa';
import VueDevTools from 'vite-plugin-vue-devtools';
import SvgLoader from 'vite-svg-loader';

const pathSrc = resolve(__dirname, 'src');

const nodePolyfillPlugins = () =>
  nodePolyfills({
    include: ['buffer', 'fs', 'path', 'crypto'],
    globals: {
      Buffer: true,
    },
    overrides: {
      fs: 'empty-module',
      path: 'empty-module',
      crypto: 'empty-module',
    },
  });

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isTest = process.env.VITEST === 'true';
  return {
  server: {
    port: 8080,
  },
  build: {
    chunkSizeWarningLimit: 5000,
  },
  plugins: [
    VueDevTools({
      componentInspector: {
        toggleComboKey: 'alt-s',
      },
    }),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        maximumFileSizeToCacheInBytes: 400 * 1024 * 1024, // 400MB：允许大模型文件
        // 排除 /models/ 路径，避免 service worker 拦截大文件请求导致 ERR_ABORTED
        navigateFallbackDenylist: [/^\/models\//],
        globIgnores: ['**/models/**'],
      },
      manifest: {
        name: 'AssetStudio Web',
        short_name: 'AS Web',
        background_color: '#f4f4f5',
        theme_color: '#f4f4f5',
        display: 'standalone',
        icons: [
          {
            sizes: '192x192',
            src: '/android-chrome-192x192.png',
            type: 'image/png',
          },
          {
            sizes: '512x512',
            src: '/android-chrome-512x512.png',
            type: 'image/png',
          },
        ],
      },
    }),
    Vue(),
    SvgLoader(),
    AutoImport({
      imports: ['vue'],
      dirs: [],
      resolvers: [ElementPlusResolver()],
      vueTemplate: true,
      dts: command === 'serve' ? resolve(pathSrc, 'auto-imports.d.ts') : false,
      eslintrc: {
        enabled: false,
        filepath: resolve(__dirname, 'eslint.config.autoImport.json'),
        globalsPropValue: 'readonly',
      },
    }),
    Components({
      dirs: [],
      resolvers: [
        IconsResolver({ enabledCollections: ['ep'], alias: { el: 'ep' } }),
        ElementPlusResolver(),
        VxeResolver({ libraryName: 'vxe-table', importStyle: true }),
      ],
      dts: command === 'serve' ? resolve(pathSrc, 'components.d.ts') : false,
    }),
    Icons(),
    ...(isTest ? [] : [nodePolyfillPlugins()]),
  ],
  worker: {
    format: 'es',
    plugins: () => nodePolyfillPlugins(),
    rolldownOptions: {
      transform: {
        inject: {
          Buffer: 'vite-plugin-node-polyfills/shims/buffer',
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'lodash-es': 'es-toolkit/compat',
      '@jimp/js-png': '@jimp/wasm-png',
    },
  },
  optimizeDeps: {
    exclude: ['@jimp/wasm-png', '@jimp/js-png', 'onnxruntime-web'],
  },
  // onnxruntime-web 需要独立 wasm 文件，避免被打包进 chunk
  // 通过 ?url 引用具体 wasm 资源路径由 Vite 处理为独立文件
  test: {
    include: ['src/**/*.test.ts'],
  },
  };
});
