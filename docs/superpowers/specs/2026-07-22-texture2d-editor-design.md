# Texture2D 浏览器内编辑器设计

## 概述

在 AssetStudio Web 中实现 Texture2D 的浏览器内编辑能力，支持用户上传新图片替换原纹理像素数据，保持原纹理格式（BC7/ASTC/DXT），并写回 AssetBundle，最终通过现有的 KH 加密流程导出可在游戏中运行的文件。

## 背景与动机

当前工作流需要借助外部工具 UABE 修改 Texture2D，步骤繁琐且容易出错（如 block size 对齐问题、compression 不匹配等）。在浏览器内直接编辑可以消除外部依赖，确保 meta 一致性，提升用户体验。

## 核心技术约束

1. `@arkntools/unity-js` 是纯只读解析库，所有字段 readonly，无序列化能力
2. 纹理解码（`decodeTexture`）只有解码，没有反向编码器
3. 修改 Asset 后需要重建 SerializedFile 和 UnityFS 容器
4. 火影手游纹理通常使用 BC7/ASTC/DXT5 压缩格式，存储在 streamData（独立 node）中

## 架构设计

### 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  前端 UI (Vue 3)                                          │
│  AssetPreview.vue → 新增 "Edit" Tab                      │
│    └─ TextureEditor.vue — 图片上传 + 预览 + 保存          │
├──────────────────────────────────────────────────────────┤
│  Store (Pinia)                                           │
│    └─ modifyTexture2D(fileId, pathId, newImageData)      │
├──────────────────────────────────────────────────────────┤
│  Worker (AssetManager)                                   │
│    └─ modifyTexture2D(fileId, pathId, newImageData)      │
│        1. 从 unityFsMap 取原始 UnityFS                    │
│        2. 用 fork 的 unity-js 重新解析                     │
│        3. 定位 Texture2D，替换像素数据                     │
│        4. 重新编码为目标格式（WASM 编码器）                 │
│        5. 重建 SerializedFile + UnityFS                   │
│        6. 更新 unityFsMap                                 │
├──────────────────────────────────────────────────────────┤
│  Fork 的 unity-js (packages/unity-js)                    │
│    ├─ ArrayBufferWriter (新增)                            │
│    ├─ Texture2D.serialize() (新增)                        │
│    ├─ Asset.rebuild() (新增)                              │
│    └─ BundleFile.rebuild() (新增)                         │
├──────────────────────────────────────────────────────────┤
│  WASM 编码器                                              │
│    ├─ bc7-encoder.wasm (BC7 格式)                        │
│    ├─ astc-encoder.wasm (ASTC 格式)                      │
│    └─ dxt-encoder.wasm (DXT1/3/5 格式)                   │
└──────────────────────────────────────────────────────────┘
```

### 数据流

```
用户上传 PNG → 解码为 RGBA → WASM 重编码为目标格式 → 替换 Texture2D 像素数据
→ 重建 SerializedFile → 重建 UnityFS → 更新 unityFsMap
→ 用户点击"加密导出" → 现有 khEncrypt 流程
```

## 详细设计

### 1. Fork unity-js

将 `@arkntools/unity-js` fork 到本地 `packages/unity-js`，作为 monorepo 子包管理。

**修改 `package.json`**：
- 将 `@arkntools/unity-js` 依赖改为 `"workspace:*"` 或本地路径引用

**保留原有代码不变**，仅添加新功能：
- 不修改现有类的只读属性
- 新增 Writer 类和 serialize/rebuild 方法

### 2. ArrayBufferWriter

对标 `ArrayBufferReader`，实现二进制写入器。

**文件**: `packages/unity-js/src/utils/writer.ts`

```typescript
export class ArrayBufferWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset: number = 0;
  private littleEndian: boolean = true;

  constructor(size: number);
  writeInt8(value: number): void;
  writeUInt8(value: number): void;
  writeInt16(value: number): void;
  writeUInt16(value: number): void;
  writeInt32(value: number): void;
  writeUInt32(value: number): void;
  writeInt64(value: bigint): void;
  writeUInt64(value: bigint): void;
  writeFloat32(value: number): void;
  writeFloat64(value: number): void;
  writeBoolean(value: boolean): void;
  writeBuffer(buffer: ArrayBuffer | Uint8Array): void;
  writeAlignedString(str: string): void; // 4 字节对齐
  align(alignment: number): void;
  getBuffer(): ArrayBuffer;
  get position(): number;
  seek(pos: number): void;
}
```

### 3. Texture2D 序列化

**两种数据存储模式，分别处理**：

#### 3a. streamData 模式（火影手游常用）

纹理数据存储在 bundle 的独立 node 中，`streamData.path` 非空。

**替换策略**：
- 定位 `bundle.nodes` 中 `path === streamData.path` 的 node
- 在 `bundle.files[nodeIndex]` 的 `streamData.offset` 处替换 `streamData.size` 字节
- 如果新数据大小不同：
  - 调整 `streamData.size` 和 `dataSize` 字段
  - 重建 Texture2D 的序列化字节（更新 streamData.size）
  - 更新 ObjectInfo 的 bytesSize
  - 重建 node 数据（splice 替换）
  - 调整后续 node 的 offset
- 如果新数据大小相同：直接 in-place 替换，无需重建

#### 3b. 内嵌模式

纹理数据内嵌在 SerializedFile 中，`streamData` 为 undefined。

**替换策略**：
- 定位 ObjectInfo 的 `bytesStart` 和 `bytesSize`
- 重建 Texture2D 序列化字节（更新 dataSize 字段）
- 替换 SerializedFile 中 bytesStart 到 bytesStart+bytesSize 的数据
- 如果新数据大小不同，调整所有后续 ObjectInfo 的 bytesStart
- 重建 SerializedFile

### 4. Texture2D.serialize()

**文件**: `packages/unity-js/src/classes/texture2d.ts`（新增方法）

```typescript
serialize(writer: ArrayBufferWriter): void {
  // 按 Unity 版本写入字段，顺序与构造函数读取顺序完全一致
  // 参考 texture2d.js constructor 的 r.read* 调用顺序
  // 关键：streamData.size 或 dataSize 更新为新值
}
```

实现要点：
- 读取顺序参照 `texture2d.js` 构造函数中的 `r.read*` / `r.move` 调用
- `r.move(n)` 对应 `writer.writeBuffer(new ArrayBuffer(n))`（零填充）
- `r.align(4)` 对应 `writer.align(4)`
- `streamData` 的 `size` 字段更新为新编码数据的大小

### 5. Asset.rebuild()

**文件**: `packages/unity-js/src/asset.ts`（新增方法）

重建 SerializedFile 的二进制数据。

```typescript
rebuild(): ArrayBuffer {
  // 1. 重新序列化所有 ObjectInfo（bytesStart 可能变化）
  // 2. 计算 metadataSize
  // 3. 写入 header + metadata + data
  // 4. 返回新的 SerializedFile ArrayBuffer
}
```

实现要点：
- header 结构：`metadataSize(u32 BE) + fileSize(u32) + version(u32) + dataOffset(u32) + endianness(u8) + padding(3)`
- metadata：unityVersion + targetPlatform + types + objectInfos
- data：所有 ObjectInfo 的序列化数据，从 dataOffset 开始
- 如果某个 ObjectInfo 的 bytesSize 变化，后续所有 ObjectInfo 的 bytesStart 需要调整

### 6. BundleFile.rebuild()

**文件**: `packages/unity-js/src/bundle.ts`（新增方法）

重建 UnityFS 容器。

```typescript
rebuild(): ArrayBuffer {
  // 1. 用修改后的 files 数组重建 block data
  // 2. 重新压缩 block（保持原 compression 类型）
  // 3. 重建 blocksInfo
  // 4. 重建 UnityFS header（更新 size、compressedBlocksInfoSize 等）
  // 5. 返回新的 UnityFS ArrayBuffer
}
```

实现要点：
- 保持原 `header.flags`（包含 compression 类型）
- 保持原 `header.signature`、`unityVersion`、`unityReversion`
- 重新压缩 block data：如果原 compression 是 LZ4/LZ4_HC，使用 `compressLz4Block`
- 重建 blocksInfo：更新 block 的 uncompressedSize 和 compressedSize
- 更新 header.size（文件总大小）、compressedBlocksInfoSize

### 7. WASM 纹理编码器

**支持格式**（按火影手游常见程度排序）：
- BC7（最常见，高质量压缩）
- ASTC 4x4 / 6x6（移动端常见）
- DXT5 / BC3（较老格式）
- RGBA32（无压缩，fallback）

**集成方式**：
- 将编码器编译为 WASM，放在 `public/wasm/` 目录
- 通过 Web Worker 加载，避免阻塞主线程
- 输入：RGBA 像素数据 + width + height + 目标格式
- 输出：编码后的压缩纹理数据

**编码器库选择**：
- BC7: `bc7enc` 或 `ispc-texcomp` 的 WASM 移植
- ASTC: `astc-encoder` 的 WASM 移植
- DXT: `libsquish` 或简单实现

### 8. 前端 UI

**新增组件**: `src/components/TextureEditor.vue`

**UI 布局**：
```
┌─────────────────────────────────────────────┐
│  原图预览              新图预览              │
│  [PNG 显示]           [上传的 PNG 显示]     │
│                                             │
│  尺寸: 1024x1024      尺寸: 1024x1024       │
│  格式: BC7            格式: BC7 (保持)      │
│                                             │
│  [上传新图片]  [恢复原图]                    │
│                                             │
│  ⚠️ 提示：新图片尺寸应与原图一致              │
│                                             │
│  [保存到 Bundle]                             │
└─────────────────────────────────────────────┘
```

**交互流程**：
1. 用户在 AssetPreview 的 "Edit" Tab 中看到当前 Texture2D 预览
2. 点击"上传新图片"，选择 PNG/JPG 文件
3. 前端解码为 ImageBitmap，检查尺寸是否匹配（不匹配时警告但仍允许）
4. 前端将 RGBA 数据发送到 Worker
5. Worker 中：WASM 编码 → 替换纹理数据 → 重建 bundle → 更新 unityFsMap
6. 成功后显示新预览，用户可继续"加密导出"

**入口点**：
- `AssetPreview.vue` 新增 `PreviewType.EDIT` 枚举值
- `PreviewComponent` computed 中添加 Texture2D → TextureEditor 的映射
- 仅对 Texture2D 类型显示 Edit Tab

### 9. AssetManager 修改

**新增方法**: `src/workers/assetManager/index.ts`

```typescript
async modifyTexture2D(
  fileId: string,
  pathId: bigint,
  rgbaData: ArrayBuffer,
  width: number,
  height: number,
): Promise<boolean>
```

实现流程：
1. 从 `unityFsMap` 取原始 UnityFS buffer
2. 用 fork 的 unity-js 重新解析（因为原解析是只读的，需要可写的副本）
3. 通过 `objectMap.get(pathId)` 定位 Texture2D
4. 检查 `streamData` 模式 vs 内嵌模式
5. 调用 WASM 编码器将 RGBA 编码为原 textureFormat
6. 替换纹理数据
7. 调用 `Texture2D.serialize()` → `Asset.rebuild()` → `BundleFile.rebuild()`
8. 更新 `unityFsMap.set(fileId, newBuffer)`
9. 更新 `bundleMap`（重新解析新 buffer）
10. 返回成功

### 10. Store 层

**新增方法**: `src/store/assetManager.ts`

```typescript
async modifyTexture2D(assetInfo: AssetInfo, imageData: ArrayBuffer, width: number, height: number)
```

通过 Comlink 调用 worker 的 `modifyTexture2D`，成功后刷新预览。

## 错误处理

| 场景 | 处理方式 |
|------|---------|
| 不支持的纹理格式 | 提示用户，提供 RGBA32 fallback 选项 |
| 新图片尺寸不匹配 | 警告但允许继续（自动缩放或保持原尺寸裁剪） |
| WASM 编码器加载失败 | 提示错误，建议使用外部工具 |
| 重建 bundle 失败 | 回滚到原始状态，提示错误详情 |
| 非 Texture2D 类型 | 隐藏 Edit Tab |

## 测试策略

1. **单元测试**：
   - ArrayBufferWriter 的写入和读取一致性
   - Texture2D serialize → parse round-trip
   - Asset rebuild 后 ObjectInfo 偏移量正确
   - BundleFile rebuild 后 blocksInfo 正确

2. **集成测试**：
   - 修改 streamData 模式的 Texture2D → 重建 bundle → 重新解析 → 验证新纹理数据
   - 修改内嵌模式的 Texture2D → 同上
   - 修改后加密导出 KH → 解密 → 验证纹理数据一致

3. **端到端测试**：
   - 导入 KH → 编辑 Texture2D → 加密导出 → 在游戏中验证

## 实施阶段

### 阶段一：基础设施
- Fork unity-js 到 packages/unity-js
- 实现 ArrayBufferWriter
- 配置 monorepo workspace

### 阶段二：序列化能力
- 实现 Texture2D.serialize()
- 实现 Asset.rebuild()
- 实现 BundleFile.rebuild()
- 单元测试

### 阶段三：纹理编码器
- 集成 BC7/ASTC/DXT WASM 编码器
- 编码器 Worker 封装
- 编码质量测试

### 阶段四：UI 与集成
- 实现 TextureEditor.vue 组件
- 修改 AssetPreview.vue 添加 Edit Tab
- 修改 AssetManager 添加 modifyTexture2D 方法
- 端到端测试

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| BC7/ASTC WASM 编码器质量不足 | 先用 RGBA32 验证流程，再逐步集成压缩格式 |
| SerializedFile 重建偏移量计算错误 | 大量单元测试覆盖各版本 |
| 重建后游戏无法读取 | 与成功对照文件逐字节对比 |
| monorepo 配置复杂 | 可先用本地 file: 引用替代 workspace |
