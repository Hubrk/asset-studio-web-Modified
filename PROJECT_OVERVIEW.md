# Asset Studio Web - 项目全面说明文档

> 本文档为接手开发的软件/AI 助手提供项目全景，涵盖架构、已完成功能、遗留问题、技术约束与下一步任务。

---

## 一、项目概述

**项目名称**: asset-studio-web
**类型**: 纯前端（WebAssembly + Web Worker）的 Unity AssetBundle 浏览器端解析与编辑工具
**核心目标**: 在浏览器中直接解析、预览、编辑 Unity AssetBundle，特别针对**火影忍者手游**的自定义加密格式（UnityKHFS/UnityKHNFS/UnityKH1FS）提供完整的解密→修改→加密回写工作流。

### 技术栈
- **前端框架**: Vue 3 + Pinia + Vue Router
- **UI 库**: Element Plus
- **构建工具**: Vite 8
- **语言**: TypeScript 6
- **Web Worker 通信**: Comlink
- **二进制解析**: 自研 `@local/unity-js`（fork 自 `@arkntools/unity-js`）
- **WASM 解码器**: `@arkntools/unity-js-tools-wasm`（BC7/ASTC/DXT/ETC 等解码）
- **LZ4 压缩**: `lz4js`
- **测试框架**: Vitest 4
- **代码规范**: ESLint + Prettier + @antfu/eslint-config

### 工作目录
- 项目根目录: `c:\Users\34072\Desktop\asset-studio-web-main`
- 操作系统: Windows
- 用户时区: Asia/Shanghai

---

## 二、目录结构

```
asset-studio-web-main/
├── packages/
│   └── unity-js/                    # Fork 的 @arkntools/unity-js，新增写入能力
│       ├── src/
│       │   ├── classes/             # Unity 类型类（Texture2D, Sprite, AudioClip 等）
│       │   │   ├── texture2d.ts     # ★ 新增 serialize() 方法
│       │   │   └── types.ts         # AssetType, TextureFormat 枚举
│       │   ├── utils/
│       │   │   ├── writer.ts        # ★ 新增 ArrayBufferWriter
│       │   │   ├── reader.ts        # 原有 ArrayBufferReader
│       │   │   └── decodeTexture.ts # 纹理解码器（输出 RGBA，内部做 bgra2rgba）
│       │   ├── asset.ts             # ★ 新增 rebuild() 方法
│       │   ├── bundle.ts            # ★ 新增 rebuild() 方法
│       │   └── index.ts             # 包入口，导出所有公共 API
│       └── package.json             # name: "@local/unity-js"
├── src/
│   ├── components/                  # Vue 组件
│   │   ├── AssetImageViewer.vue
│   │   ├── AssetAudioViewer.vue
│   │   ├── AssetTextViewer.vue
│   │   ├── AssetSpineViewer.vue
│   │   ├── AssetInspectViewer.vue
│   │   ├── AssetTypeTreeViewer.vue
│   │   └── ... (尚未创建 TextureEditor.vue)
│   ├── views/
│   │   ├── AssetPreview.vue         # ★ 待修改：添加 Edit Tab
│   │   ├── AssetList.vue
│   │   └── ResourceList.vue
│   ├── store/
│   │   ├── assetManager.ts          # ★ 待修改：添加 modifyTexture2D
│   │   ├── setting.ts
│   │   ├── progress.ts
│   │   └── repository.ts
│   ├── workers/
│   │   └── assetManager/
│   │       ├── index.ts             # ★ 待修改：添加 modifyTexture2D 方法
│   │       ├── loaders/             # 各类型资源的加载器
│   │       └── utils/
│   ├── utils/
│   │   ├── khDecrypt.ts             # KH 解密逻辑
│   │   ├── khEncrypt.ts             # KH 加密逻辑
│   │   ├── textureEncoder.ts        # ★ 已创建，BC7/ASTC 编码器有 bug
│   │   └── __tests__/               # 测试文件目录
│   ├── types/
│   │   ├── preview.ts               # ★ 待修改：添加 Edit 到 PreviewType
│   │   ├── export.ts
│   │   └── repository.ts
│   ├── locale/                      # i18n（中英文）
│   └── App.vue
├── docs/
│   └── superpowers/
│       ├── specs/
│       │   └── 2026-07-22-texture2d-editor-design.md   # 设计文档
│       └── plans/
│           ├── 2026-07-22-texture2d-editor-stage1-2.md # 阶段一+二计划（已完成）
│           └── 2026-07-22-texture2d-editor-stage3-4.md # 阶段三+四计划（进行中）
└── package.json
```

---

## 三、核心功能模块

### 3.1 KH 加密/解密（已完成，稳定）

**文件**:
- `src/utils/khDecrypt.ts` — 解密
- `src/utils/khEncrypt.ts` — 加密

**支持格式**:
- `UnityKHFS` (key 索引 0)
- `UnityKHNFS` (key 索引 1)
- `UnityKH1FS` (key 索引 2)

**关键设计**:
- **解密布局**: `magic(9) + o(31) + s(12) + flags(11/12) = 64/63 字节` header
  - `o` 从 UnityFS[7:38] 提取
  - `s` 从 UnityFS[38:50] 提取
- **解密流程**: XOR 解密 → 逆向字节旋转 → 提取标准 UnityFS
- **加密流程**: 提取 o/s → 8 字节对齐 block data → 重新压缩 blocksInfo 到原 compression → 构建 KH header
- **meta 复用**: 通过文件名匹配（提取最长数字串作为 ID）关联修改后的 FS 与原始 KH meta
- **尾部校验**: 加密后文件尾部需包含 6 字节校验数据以确保游戏兼容性
- **block 对齐**: UnityFS block size 必须 8 字节对齐（非 16 字节）

**关键约束**:
- KH 加密会清除 UnityFS flags 的 0x80 位（blocksInfoCompressed），解密时需根据 blocks info 压缩状态自动恢复
- 加密块长度 `c` 必须修正为原始 KH 文件值（如 88 或 100 字节），即使 UABE 修改后 UnityFS 的 blocksInfoSize 变化
- lz4js 的压缩输出可能导致游戏引擎无法解压，需保持原 compression 或使用未压缩模式

### 3.2 Fork 的 unity-js（已完成，稳定）

**位置**: `packages/unity-js/`
**包名**: `@local/unity-js`（在根 package.json 中以 `file:packages/unity-js` 引用为 `@arkntools/unity-js`）

**新增能力**:

#### ArrayBufferWriter (`packages/unity-js/src/utils/writer.ts`)
- 对标 `ArrayBufferReader` 的二进制写入器
- 默认 `littleEndian = true`（与 Reader 一致）
- 支持所有基本类型：Int8/UInt8/Int16/UInt16/Int32/UInt32/Int64/UInt64/Float32/Float64
- 支持 LE/BE 变体（通过动态生成方法）
- `writeAlignedString`, `writeStringUntilZero`, `align`, `seek`, `move`

#### Texture2D.serialize() (`packages/unity-js/src/classes/texture2d.ts`)
- **策略**: 镜像构造函数——从 `getRaw()` 读取原始字节，按 constructor 顺序逐步写入
- **支持两种模式**:
  - **streamData 模式**: 纹理数据存储在 bundle 的独立 node 中（火影手游常用）
  - **内嵌模式**: 纹理数据内嵌在 SerializedFile 中
- 关键方法 `copyMove(r, w, n)`: 从 reader 读取 n 字节并写入 writer（用于 `r.move(n)` 对应的字段）

#### Asset.rebuild() (`packages/unity-js/src/asset.ts`)
- **策略**: "复制原始 buffer + 原地 patch"
- 未修改时：返回原始字节副本
- 已修改但大小未变：原地 patch 修改的 ObjectInfo 数据
- **限制**: 大小变化时抛出错误（metadata 重建未实现）

#### BundleFile.rebuild() (`packages/unity-js/src/bundle.ts`)
- **策略**: 始终重建，使用未压缩 block data（compression=0）作为 fallback
- 拼接所有 files 为单个 block → 重建 blocksInfo → 重建 header
- **限制**: 未实现 LZ4/LZ4_HC 压缩的 block data 重建

### 3.3 纹理编码器（进行中，有遗留 bug）

**文件**: `src/utils/textureEncoder.ts`

**已实现的编码器**:
| 格式 | 状态 | 说明 |
|------|------|------|
| RGBA32 | ✅ 工作正常 | 直接复制 |
| BGRA32 | ✅ 工作正常 | 交换 R 和 B |
| DXT1/BC1 | ✅ 工作正常 | RGB565 端点 + 2-bit 索引 |
| DXT5/BC3 | ✅ 工作正常 | DXT1 + 8-bit alpha 端点 |
| BC7 | ❌ **有 bug** | 模式 6，位布局问题 |
| ASTC 4x4 | ❌ **有 bug** | void extent 模式，位布局问题 |

**导出 API**:
```typescript
encodeTexture(rgba, width, height, format: TF): Uint8Array
isFormatSupported(format: TF): boolean
getSupportedFormats(): TF[]
```

**⚠️ 遗留问题 — BC7 和 ASTC 编码器位布局错误**:

**BC7 编码器（模式 6）**:
- 输入: R=200, G=100, B=50, A=255 (纯色 4x4)
- 编码字节: `20 c8 b2 cc 9f 2c cb fc 01 00 00 00 00 00 00 00`
- 解码结果: R=145, G=100, B=147, A=50（G 正确，R/B/A 错误）
- 分析: A=50 看起来是输入的 B 值，可能存在通道顺序问题或位偏移问题

**ASTC 4x4 编码器（void extent）**:
- 输入: R=200, G=100, B=50, A=255 (纯色 4x4)
- 编码字节: `fc fd ff ff ff ff ff 7f 46 36 b2 91 f9 7f 00 00`
- 解码结果: R=54, G=145, B=127, A=0（所有通道错误）
- 分析: 位布局可能根本性错误

**可能的根本原因**:
- `decodeTexture` 对非 RGBA32 格式会调用 `bgra2rgba(decodeFunc(...))`，即 WASM 解码器输出 BGRA，然后转 RGBA
- 编码器存储的 RGBA 值在 WASM 解码后会变成 BGRA，再经 bgra2rgba 变回 RGBA
- 需要验证这个转换链是否正确，以及 WASM decodeBc7/decodeAstc 的实际输出格式

**调试文件**:
- `src/utils/__tests__/debugEncoder.test.ts` — 打印编码字节和解码像素

### 3.4 纹理解码器约定（重要）

**文件**: `packages/unity-js/src/utils/decodeTexture.ts`

```typescript
// 解码流程：
// 1. RGBA32 格式直接返回
// 2. 其他格式调用 WASM decodeFunc（输出 BGRA）
// 3. 调用 bgra2rgba 转为 RGBA
const bgra2rgba = (data) => {
  for (let i = 0; i + 3 < data.length; i += 4) {
    [data[i], data[i + 2]] = [data[i + 2], data[i]]; // 交换 R 和 B
  }
  return data;
};
```

**含义**: 编码器存储的值会被 WASM 解码器读取并输出 BGRA，然后 bgra2rgba 交换 R/B 还原 RGBA。编码器实现时需注意这个转换链。

### 3.5 AssetManager Worker（待扩展）

**文件**: `src/workers/assetManager/index.ts`

**核心数据结构**:
```typescript
class AssetManager {
  private bundleMap = new Map<string, AssetFile>();        // fileId → 解析后的 AssetFile
  private unityFsMap = new Map<string, ArrayBuffer>();      // fileId → 原始 UnityFS buffer
  private khMetaMap = new Map<string, KhBundleMeta>();      // fileId → KH meta
  private khMetaByFileName = new Map<string, KhBundleMeta>(); // 文件名 → KH meta（用于复用）
}
```

**待添加方法**: `modifyTexture2D(fileId, pathId, rgbaData, width, height)`

---

## 四、Texture2D 编辑器设计（阶段三+四）

### 整体架构

```
┌──────────────────────────────────────────────────┐
│  前端 UI (Vue 3)                                  │
│  AssetPreview.vue → 新增 "Edit" Tab              │
│    └─ TextureEditor.vue — 图片上传 + 预览 + 保存  │
├──────────────────────────────────────────────────┤
│  Store (Pinia)                                   │
│    └─ modifyTexture2D(assetInfo, imageData, w, h)│
├──────────────────────────────────────────────────┤
│  Worker (AssetManager)                           │
│    └─ modifyTexture2D(fileId, pathId, rgbaData)  │
│        1. 从 unityFsMap 取原始 UnityFS            │
│        2. 用 fork 的 unity-js 重新解析             │
│        3. 定位 Texture2D，替换像素数据             │
│        4. 重新编码为目标格式                       │
│        5. 重建 SerializedFile + UnityFS           │
│        6. 更新 unityFsMap                         │
├──────────────────────────────────────────────────┤
│  Fork 的 unity-js (packages/unity-js)            │
│    ├─ ArrayBufferWriter      ✅ 已完成            │
│    ├─ Texture2D.serialize()  ✅ 已完成            │
│    ├─ Asset.rebuild()        ✅ 已完成（有限制）  │
│    └─ BundleFile.rebuild()   ✅ 已完成（有限制）  │
├──────────────────────────────────────────────────┤
│  纹理编码器 (src/utils/textureEncoder.ts)        │
│    ├─ RGBA32/BGRA32  ✅                          │
│    ├─ DXT1/DXT5      ✅                          │
│    ├─ BC7            ❌ 位布局 bug               │
│    └─ ASTC 4x4       ❌ 位布局 bug               │
└──────────────────────────────────────────────────┘
```

### 数据流

```
用户上传 PNG → 解码为 RGBA → 编码为目标格式 → 替换 Texture2D 像素数据
→ 重建 SerializedFile → 重建 UnityFS → 更新 unityFsMap
→ 用户点击"加密导出" → 现有 khEncrypt 流程
```

---

## 五、任务进度

### 阶段一+二（已完成 ✅）

| Task | 内容 | 状态 |
|------|------|------|
| 1 | Fork unity-js 到 packages/unity-js | ✅ |
| 2 | ArrayBufferWriter | ✅ |
| 3 | Texture2D.serialize() | ✅ |
| 4 | Asset.rebuild() | ✅ |
| 5 | BundleFile.rebuild() | ✅ |
| 6 | 端到端修改测试 | ✅ |
| 7 | 全量回归 | ✅ (67 测试通过) |

### 阶段三+四（进行中 🚧）

| Task | 内容 | 状态 |
|------|------|------|
| 8 | 纹理编码器实现 | 🚧 15/17 测试通过，BC7 和 ASTC 失败 |
| 9 | AssetManager.modifyTexture2D 方法 | ❌ 未开始 |
| 10 | Store 层 modifyTexture2D 方法 | ❌ 未开始 |
| 11 | TextureEditor.vue 组件 + PreviewType.Edit | ❌ 未开始 |
| 12 | AssetPreview.vue 添加 Edit Tab | ❌ 未开始 |
| 13 | 端到端测试 + 全量回归 | ❌ 未开始 |

---

## 六、遗留问题详解

### 6.1 BC7 编码器位布局问题（Task 8）

**当前实现位置**: `src/utils/textureEncoder.ts` 第 192-279 行

**当前位布局（mode 6, bit 5 = 0x20）**:
```
- bits [6:0]: 模式标记 (bit 5 = 1 → 0x20)
- bits [8:7]: rotation (2 bit, 0)
- bits [15:9]: endpoint0 R (7 bit)
- bits [22:16]: endpoint0 G (7 bit)
- bits [29:23]: endpoint0 B (7 bit)
- bits [36:30]: endpoint0 A (7 bit)
- bits [43:37]: endpoint1 R (7 bit)
- bits [50:44]: endpoint1 G (7 bit)
- bits [57:51]: endpoint1 B (7 bit)
- bits [64:58]: endpoint1 A (7 bit)
- bits [67:65]: index0 (3 bit, anchor)
- bits [71:68] ~ bits [127:124]: 15 × 4-bit 索引
```

**调试结果**:
- 输入(200,100,50,255) → 编码 `20 c8 b2 cc 9f 2c cb fc 01 00...` → 解码(145,100,147,50)
- G 通道正确(100)，但 R/B/A 错误
- 解码的 A=50 看起来是输入的 B=50

**已尝试的修复**:
1. 改为 bit 6 (0x40) — 结果更差
2. 改回 bit 5 (0x20) — 仍然失败

**建议排查方向**:
- 查阅 BC7 规范确认 mode 6 的位布局
- 验证 WASM decodeBc7 期望的位读取顺序
- 检查 bgra2rgba 转换链是否影响通道顺序
- 考虑端点顺序（maxP/minP vs endpoint0/endpoint1）

### 6.2 ASTC 4x4 编码器位布局问题（Task 8）

**当前实现位置**: `src/utils/textureEncoder.ts` 第 300-384 行

**当前位布局（void extent）**:
```
- bits [8:0] = 0x1FC (void extent 标记, 9 bit)
- bits [10:9] = 0b10 (D, 2 bit, 必须非零)
- bits [23:11] = S0 (13 bit, 全 1)
- bits [36:24] = T0 (13 bit)
- bits [49:37] = S1 (13 bit)
- bits [62:50] = T1 (13 bit)
- bits [74:63] = R (12 bit)
- bits [86:75] = G (12 bit)
- bits [98:87] = B (12 bit)
- bits [110:99] = A (12 bit)
- bits [127:111] = 0 (17 bit 填充)
```

**调试结果**:
- 输入(200,100,50,255) → 编码 `fc fd ff ff ff ff ff 7f 46 36 b2 91 f9 7f 00 00` → 解码(54,145,127,0)
- 所有通道都错误

**已尝试的修复**:
1. bits [10:0]=0 + bits [12:11]=0b01 + 两个 12-bit 端点 — 失败
2. bits [8:0]=0x1FC + bits [12:9]=0xF + bits [24:13]=0xFFF + 两个端点 — 失败
3. 当前方案（4×13-bit extent + 4×12-bit 颜色）— 仍然失败

**建议排查方向**:
- 查阅 Khronos ASTC 规范或 ARM astc-encoder 源码
- 确认 void extent 块的正确位布局
- 验证 12-bit 颜色值的编码方式（当前用 `(v << 4) | (v >> 4)`）

### 6.3 Asset.rebuild() 的限制

- 不支持 ObjectInfo 大小变化的场景（抛出错误）
- 仅支持等大小替换
- metadata 重建（调整 bytesStart/bytesSize）未实现

### 6.4 BundleFile.rebuild() 的限制

- 使用未压缩 block data（compression=0）
- 未实现 LZ4/LZ4_HC 压缩
- 重建后的 bundle 可被 Studio Web 解析，但**游戏可读性未验证**

### 6.5 未验证的游戏兼容性

- 重建后的 bundle 通过 Studio Web 可正常解析
- 但尚未在游戏中验证可读性
- 特别是 LZ4_HC 压缩的 bundle 重建后，游戏可能无法解压

---

## 七、关键文件索引

### 已完成且稳定的文件

| 文件 | 说明 |
|------|------|
| `packages/unity-js/src/utils/writer.ts` | ArrayBufferWriter 实现 |
| `packages/unity-js/src/classes/texture2d.ts` | Texture2D.serialize() |
| `packages/unity-js/src/asset.ts` | Asset.rebuild() |
| `packages/unity-js/src/bundle.ts` | BundleFile.rebuild() |
| `packages/unity-js/src/index.ts` | 包入口，导出 ArrayBufferWriter, decodeTexture, TextureFormat |
| `src/utils/khDecrypt.ts` | KH 解密逻辑 |
| `src/utils/khEncrypt.ts` | KH 加密逻辑 |

### 有遗留问题的文件

| 文件 | 问题 |
|------|------|
| `src/utils/textureEncoder.ts` | BC7 和 ASTC 编码器位布局错误 |
| `src/utils/__tests__/textureEncoder.test.ts` | 15/17 测试通过，2 个失败 |
| `src/utils/__tests__/debugEncoder.test.ts` | 调试用测试 |

### 待创建/修改的文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/components/TextureEditor.vue` | 创建 | 纹理编辑器 UI 组件 |
| `src/workers/assetManager/index.ts` | 修改 | 添加 modifyTexture2D 方法 |
| `src/store/assetManager.ts` | 修改 | 添加 modifyTexture2D store 方法 |
| `src/views/AssetPreview.vue` | 修改 | 添加 Edit Tab |
| `src/types/preview.ts` | 修改 | 添加 Edit 到 PreviewType 枚举 |

### 测试文件

| 文件 | 测试数 | 状态 |
|------|--------|------|
| `arrayBufferWriter.test.ts` | 9 | ✅ 全部通过 |
| `texture2dSerialize.test.ts` | 1 | ✅ 通过 |
| `assetRebuild.test.ts` | 1 | ✅ 通过 |
| `bundleRebuild.test.ts` | 2 | ✅ 通过 |
| `khRoundtrip.test.ts` | 34 | ✅ 全部通过 |
| `khRecompress.test.ts` | 8 | ✅ 全部通过 |
| `khModifiedFile.test.ts` | 6 | ✅ 全部通过 |
| `khFreshDecrypt.test.ts` | 4 | ✅ 全部通过 |
| `textureModify.test.ts` | 2 | ✅ 通过 |
| `textureEncoder.test.ts` | 17 | ❌ 15 通过，2 失败（BC7/ASTC） |
| `debugEncoder.test.ts` | 2 | 调试用 |

---

## 八、测试运行方式

```bash
# 运行所有测试
node node_modules/vitest/vitest.mjs run

# 运行特定测试文件
node node_modules/vitest/vitest.mjs run src/utils/__tests__/textureEncoder.test.ts

# 监视模式
node node_modules/vitest/vitest.mjs
```

**注意**: 由于 PowerShell 执行策略限制，`npx vitest` 可能无法运行，使用 `node node_modules/vitest/vitest.mjs` 直接调用。

---

## 九、关键技术约定

### 9.1 KH 加密 round-trip 布局

```
解密后的 UnityFS buffer 布局:
  UnityFS(7) + o(31) + s(12) + padding(14) + decrypted_data(l) + remaining(u)
  DECRYPTED_HEADER_SIZE = 64
```

### 9.2 block 对齐

- UnityFS block size 必须 **8 字节对齐**（非 16 字节）以确保游戏兼容性
- `alignUnityFsBlock` 函数处理对齐 + trailing `00 00`

### 9.3 meta 复用机制

- 导入 KH 文件时保存 `文件名 → meta` 映射至 `khMetaByFileName` Map
- 通过提取文件名中最长数字串作为核心 ID 匹配原始 KH 的 meta
- 复用 meta 时需同步 meta 中的 compression 为修改后文件的 compression

### 9.4 尾部校验数据

- 加密后的文件尾部需包含 **6 字节校验数据**以确保游戏兼容性
- 这不是简单的 checksum，而是游戏验证机制的一部分

### 9.5 压缩处理

- 火影手游的原始 KH 文件 flags 本身就是全零的
- 无法通过 flags 是否全零判断是否使用 meta，需改用 **tail 长度判据**
- lz4js 的压缩输出可能导致游戏引擎无法解压，需保持原 compression 或使用未压缩模式

---

## 十、下一步任务指引

### Task 8: 修复 BC7 和 ASTC 编码器（优先）

**目标**: 让 `textureEncoder.test.ts` 的 17 个测试全部通过

**步骤**:
1. 研究 BC7 mode 6 规范（Khronos Group 或 Microsoft 文档）
2. 研究 ASTC void extent 规范（Khronos ASTC spec 或 ARM astc-encoder 源码）
3. 修复 `src/utils/textureEncoder.ts` 中的位布局
4. 运行 `node node_modules/vitest/vitest.mjs run src/utils/__tests__/textureEncoder.test.ts` 验证

### Task 9: AssetManager.modifyTexture2D

**文件**: `src/workers/assetManager/index.ts`

**新增方法**:
```typescript
async modifyTexture2D(
  fileId: string,
  pathId: bigint,
  rgbaData: ArrayBuffer,
  width: number,
  height: number,
): Promise<boolean>
```

**流程**:
1. 从 `unityFsMap` 取原始 UnityFS buffer
2. 用 `loadAssetBundle` 重新解析
3. 通过 `objectMap.get(pathId)` 定位 Texture2D
4. 检查 `streamData` 模式 vs 内嵌模式
5. 调用 `encodeTexture` 将 RGBA 编码为原 textureFormat
6. 替换纹理数据（in-place 如果大小不变）
7. 调用 `Texture2D.serialize()` → `Asset.rebuild()` → `BundleFile.rebuild()`
8. 更新 `unityFsMap.set(fileId, newBuffer)`
9. 返回成功

### Task 10: Store 层 modifyTexture2D

**文件**: `src/store/assetManager.ts`

通过 Comlink 调用 worker 的 `modifyTexture2D`，成功后刷新预览。

### Task 11: TextureEditor.vue 组件

**文件**: `src/components/TextureEditor.vue`（创建）

**UI 布局**:
- 原图预览 + 新图预览
- 上传按钮 + 恢复原图按钮
- 尺寸/格式信息显示
- 保存到 Bundle 按钮

**同时修改**: `src/types/preview.ts` 添加 `Edit` 到 `PreviewType` 枚举

### Task 12: AssetPreview.vue 添加 Edit Tab

**文件**: `src/views/AssetPreview.vue`

- 在 `PreviewTab` 枚举中添加 `Edit = 'edit'`
- 仅对 Texture2D 类型显示 Edit Tab
- 在 `PreviewComponent` computed 中添加 `case 'edit'` → `TextureEditor`

### Task 13: 端到端测试

**文件**: `src/utils/__tests__/textureEditorE2E.test.ts`（创建）

测试: 编码 RGBA → 替换 → rebuild → 重新解析验证

---

## 十一、重要的实现细节

### 11.1 Texture2D.serialize() 的镜像策略

```typescript
serialize(writer: ArrayBufferWriter): void {
  const rawBytes = this.getRaw();
  const r = new ArrayBufferReader(rawBytes);
  // 严格按构造函数中 r.read* / r.move 的顺序
  // 对于保存的属性（width, height, textureFormat, name），写入当前值
  // 对于跳过的字段（r.move），用 copyMove 从原始字节复制
}
```

### 11.2 Asset.rebuild() 的 patch 策略

```typescript
rebuild(): ArrayBuffer {
  // 如果没有修改，返回原始字节副本
  if (modifiedInfos.length === 0) return rawData.slice(0);
  // 如果大小变化，抛出错误
  if (sizeChanged) throw new Error('metadata rebuild not implemented');
  // 大小不变：复制原始 buffer，原地 patch 修改的区域
  const result = new Uint8Array(rawData.slice(0));
  for (const info of modifiedInfos) {
    result.set(new Uint8Array(info._modifiedData), info.bytesStart);
  }
  return result.buffer;
}
```

### 11.3 BundleFile.rebuild() 的未压缩策略

```typescript
rebuild(): ArrayBuffer {
  // 1. 拼接所有 files 为单个 block
  const blockData = concatArrayBuffer([...this.files]);
  // 2. 重建 blocksInfo（uncompressed）
  // 3. 重建 header（flags 清除 compression 位）
  // 4. 返回新的 UnityFS buffer
}
```

### 11.4 解码器通道顺序约定

```
解码: WASM decodeFunc 输出 BGRA → bgra2rgba 交换 R/B → 输出 RGBA
编码: 编码器存储 RGBA → WASM 解码读取 → 输出 BGRA → bgra2rgba → RGBA

⚠️ 这意味着编码器写入的 "R" 值，在 WASM 解码后会出现在 "B" 位置
   然后被 bgra2rgba 交换回 "R" 位置
   理论上应该 round-trip 一致，但需验证 WASM 解码器的实际行为
```

---

## 十二、参考资源

### 规范文档
- **BC7 规范**: Khronos Data Format Specification (BC7 部分)
- **ASTC 规范**: Khronos ASTC Specification (void extent 部分)
- **UnityFS 格式**: Unity AssetBundle 内部格式

### 项目内文档
- `docs/superpowers/specs/2026-07-22-texture2d-editor-design.md` — 完整设计文档
- `docs/superpowers/plans/2026-07-22-texture2d-editor-stage1-2.md` — 阶段一+二实施计划
- `docs/superpowers/plans/2026-07-22-texture2d-editor-stage3-4.md` — 阶段三+四实施计划

### 外部依赖
- `@arkntools/unity-js-tools-wasm` — WASM 解码器，提供 decodeBc7/decodeAstc 等函数
- `lz4js` — LZ4 压缩/解压
- `comlink` — Web Worker RPC

---

## 十三、用户偏好与工作流

### 用户工作流

```
1. 导入火影手游 KH 文件 (UnityKHFS/UnityKHNFS/UnityKH1FS)
2. Studio Web 自动解密为 UnityFS
3. 预览/查看资源
4. (目标) 在 Edit Tab 中上传新 PNG 替换 Texture2D
5. 导出加密后的 KH 文件
6. 在游戏中测试
```

### 用户偏好
- 沟通语言: 中文
- 偏好平滑过渡和动画
- 重视视觉美学
- 希望设置具有记忆功能
- 全页面显示无滚动
- 支持中英文切换

### 测试文件位置
- 火影手游测试文件: `C:\Users\34072\Desktop\纯立绘\宇智波佐助[万花筒写轮眼]90059\`
  - `110943700.assetbundle`
  - `4087659059.assetbundle`
- 加密测试对照文件: `C:\Users\34072\Desktop\测试\成功对照\`

---

## 十四、快速上手检查清单

接手开发时，建议按以下顺序确认环境：

- [ ] 运行 `node node_modules/vitest/vitest.mjs run` 确认所有测试通过（除 BC7/ASTC 2 个失败）
- [ ] 检查 `packages/unity-js/src/index.ts` 导出 `ArrayBufferWriter`, `decodeTexture`, `TextureFormat`
- [ ] 确认 `package.json` 中 `"@arkntools/unity-js": "file:packages/unity-js"`
- [ ] 查看 `src/utils/textureEncoder.ts` 当前 BC7/ASTC 实现
- [ ] 运行 `node node_modules/vitest/vitest.mjs run src/utils/__tests__/debugEncoder.test.ts` 查看调试输出
- [ ] 阅读设计文档 `docs/superpowers/specs/2026-07-22-texture2d-editor-design.md`

---

**文档生成时间**: 2026-07-22
**项目版本**: 0.0.0 (private)
**最后更新**: 阶段三 Task 8 调试中
