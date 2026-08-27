/**
 * 为遗留 CJS / ESM 混淆的依赖打补丁（幂等）。
 *
 * 1) CJS interop：exif-parser / mime 是纯 CJS（module.exports 无 default），rolldown-vite(8)
 *    预构建时若未提供 default 导出，`import X from '...'` 会在浏览器报
 *    "does not provide an export named 'default'" 而整页白屏。
 *    通过静态可识别的 module.exports.__esModule/default 自引用，转换器会同时产出 default。
 *
 * 2) wasm-bindgen 包归一：@arkntools/unity-js-tools-wasm 的 index.browser.js 是 ESM（含 export 块）
 *    但所在包无 "type": "module"，vite 会误按 CJS 处理导致导出丢失（decodeAstc 等 named import 报错）。
 *    复制一份 .mjs 副本，配合 vite.config 的 alias 以 ESM 身份加载。
 *
 * 依赖重装后自动恢复（见 package.json 的 postinstall）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 要补丁的文件（均为无 type:module 的 CJS） */
const CJS_TARGETS = [
  'node_modules/exif-parser/index.js',
  'node_modules/mime/lite.js',
];

const SNIPPET =
  '\n// [asset-studio-web] CJS interop shim: expose self as default export\n' +
  'module.exports.__esModule = true;\n' +
  'module.exports.default = module.exports;\n';

/** wasm-bindgen 浏览器入口：复制为 .mjs（强制 ESM 语义，保留静态 export） */
const ESM_COPIES = [
  {
    from: 'node_modules/@arkntools/unity-js-tools-wasm/index.browser.js',
    to: 'node_modules/@arkntools/unity-js-tools-wasm/index.browser.mjs',
  },
];

let changed = 0;
for (const rel of CJS_TARGETS) {
  const file = path.resolve(__dirname, '..', rel);
  if (!fs.existsSync(file)) {
    console.warn(`[patch-legacy-cjs] skip (missing): ${rel}`);
    continue;
  }
  let src = fs.readFileSync(file, 'utf8');
  // 移除旧的 defineProperty 版补丁（若有），再按最新规则补齐
  src = src.replace(/\/\/ \[asset-studio-web\] CJS interop shim[\s\S]*$/, '');
  if (src.includes('module.exports.default = module.exports')) continue; // 已是最新补丁
  fs.writeFileSync(file, src + SNIPPET);
  changed++;
  console.log(`[patch-legacy-cjs] patched: ${rel}`);
}

for (const { from, to } of ESM_COPIES) {
  const fromFile = path.resolve(__dirname, '..', from);
  const toFile = path.resolve(__dirname, '..', to);
  if (!fs.existsSync(fromFile)) {
    console.warn(`[patch-legacy-cjs] skip (missing): ${from}`);
    continue;
  }
  if (fs.existsSync(toFile)) continue; // 已生成
  fs.copyFileSync(fromFile, toFile);
  changed++;
  console.log(`[patch-legacy-cjs] copied: ${from} -> ${path.basename(toFile)}`);
}

console.log(changed ? `[patch-legacy-cjs] done, patched ${changed} item(s).` : '[patch-legacy-cjs] nothing to patch.');