# Texture2D 编辑器 - 阶段三+四：纹理编码器与 UI 集成

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 实现纯 JS 纹理编码器（RGBA32/DXT5/BC7/ASTC），在 AssetManager 中添加 modifyTexture2D 方法，创建 TextureEditor.vue 组件并集成到 AssetPreview。

**Architecture:** 编码器直接在 AssetManager worker 中实现（避免额外 worker 通信）。UI 使用 Element Plus 组件，通过 Comlink 调用 worker 的 modifyTexture2D。

**Tech Stack:** TypeScript, Vue 3, Element Plus, Comlink, Vitest

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/utils/textureEncoder.ts` | 纹理编码器（RGBA32/DXT5/BC7/ASTC） | 创建 |
| `src/utils/__tests__/textureEncoder.test.ts` | 编码器测试 | 创建 |
| `src/workers/assetManager/index.ts` | 添加 modifyTexture2D 方法 | 修改 |
| `src/store/assetManager.ts` | 添加 modifyTexture2D store 方法 | 修改 |
| `src/components/TextureEditor.vue` | 纹理编辑器 UI 组件 | 创建 |
| `src/views/AssetPreview.vue` | 添加 Edit tab | 修改 |
| `src/types/preview.ts` | 添加 Edit PreviewType | 修改 |

---

## Task 8: 纹理编码器实现

**Files:**
- Create: `src/utils/textureEncoder.ts`
- Create: `src/utils/__tests__/textureEncoder.test.ts`

实现以下编码器（纯 JS）：
- **RGBA32**: 直接 BGRA→RGBA 转换
- **DXT5/BC3**: 4x4 块，2 个 RGB 端点 + 4 bit 索引，alpha 使用 8 端点
- **BC7**: 使用模式 6（2 个 RGBA 端点，7 bits/通道，4 bit 索引）
- **ASTC 4x4**: 使用 void extent 常数颜色模式（每块单色，质量低但可用）

每个编码器输入：RGBA Uint8Array + width + height
输出：编码后的 Uint8Array

---

## Task 9: AssetManager.modifyTexture2D

**Files:**
- Modify: `src/workers/assetManager/index.ts`

新增方法：
```typescript
async modifyTexture2D(fileId: string, pathId: bigint, rgbaData: ArrayBuffer): Promise<boolean>
```

流程：
1. 从 unityFsMap 取原始 UnityFS buffer
2. 用 loadAssetBundle 重新解析
3. 定位 Texture2D
4. 编码 RGBA 为原 textureFormat
5. 替换 streamData 或内嵌数据
6. Asset.rebuild() → BundleFile.rebuild()
7. 更新 unityFsMap 和 bundleMap

---

## Task 10: Store 层 modifyTexture2D

**Files:**
- Modify: `src/store/assetManager.ts`

通过 Comlink 调用 worker，成功后返回新预览。

---

## Task 11: TextureEditor.vue 组件

**Files:**
- Create: `src/components/TextureEditor.vue`
- Modify: `src/types/preview.ts` (添加 Edit PreviewType)

UI：原图预览 + 上传按钮 + 保存按钮。

---

## Task 12: AssetPreview.vue 添加 Edit Tab

**Files:**
- Modify: `src/views/AssetPreview.vue`

仅对 Texture2D 类型显示 Edit tab。

---

## Task 13: 端到端测试

**Files:**
- Create: `src/utils/__tests__/textureEditorE2E.test.ts`

测试：编码 RGBA → 替换 → rebuild → 重新解析验证。
