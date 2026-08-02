# 自动化测试方案：KH 加密/解密模块

## 摘要

为 `src/utils/khDecrypt.ts` 和 `src/utils/khEncrypt.ts` 建立自动化单元测试，验证：
- **Round-trip 正确性**：原始 KHFS/KHNFS/KH1FS 文件 → 解密 → 加密 → 与原始逐字节一致
- **Fresh 加密正确性**：任意 UnityFS → 加密 → 解密 → 与原始逐字节一致
- **三种格式独立验证**：UnityKHFS / UnityKHNFS / UnityKH1FS 各有不同算法
- **边界情况**：空数据、单字节数据、大文件、eRot=0 特殊情况

工具选择：**Vitest**（项目已使用 Vite，零额外配置即可运行）

---

## 当前状态分析

| 维度 | 现状 |
|------|------|
| 测试框架 | 无（package.json 没有 test 脚本） |
| 测试文件 | 0 个 |
| 测试依赖 | 无（vitest、jest 等均未安装） |
| 外部验证 | `test_roundtrip_kh.py`（Python 独立脚本，不随 TS 代码自动运行） |
| 被测模块 | `khDecrypt.ts` 和 `khEncrypt.ts`——纯算法、零外部依赖、天然可测试 |
| 测试素材 | `C:\Users\34072\Desktop\纯立绘\宇智波佐助[万花筒写轮眼]90059\110943700.assetbundle` 和 `4087659059.assetbundle`（火影忍者手游真实 KH 加密文件） |

---

## 计划变更

### 1. 安装 Vitest

**文件**: `package.json`

添加 devDependency `vitest`，添加 test 脚本：

```json
"devDependencies": {
  "vitest": "^2.x"
},
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest"
}
```

**操作**: `npm install -D vitest`

---

### 2. 配置 Vitest

**文件**: `vite.config.ts`

在现有配置中添加 `test` 块：

```typescript
/// <reference types="vitest" />
export default defineConfig({
  // ... 现有配置 ...
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

Vitest 复用 Vite 的 `@` 别名、TypeScript 转译等配置，无需额外设置。

---

### 3. 创建单元测试文件

**文件**: `src/utils/__tests__/khRoundtrip.test.ts`

#### 3.1 测试数据准备

- 使用 `crypto.getRandomValues` 或硬编码字节生成模拟的 KH 文件结构
- 使用用户指定的真实游戏文件：`C:\Users\34072\Desktop\纯立绘\宇智波佐助[万花筒写轮眼]90059\110943700.assetbundle` 和 `4087659059.assetbundle`

#### 3.2 测试用例清单

| # | 测试名称 | 输入 | 预期结果 |
|---|---------|------|---------|
| 1 | `roundtrip KHFS byte-exact` | 构建模拟 UnityKHFS 文件 → decrypt → encrypt | encrypt 输出 = 原始文件 |
| 2 | `roundtrip KHNFS byte-exact` | 构建模拟 UnityKHNFS 文件 → decrypt → encrypt | encrypt 输出 = 原始文件 |
| 3 | `roundtrip KH1FS byte-exact` | 构建模拟 UnityKH1FS 文件 → decrypt → encrypt | encrypt 输出 = 原始文件 |
| 4 | `fresh encrypt → decrypt = original` | 构建随机 UnityFS → encryptUnityFsToKhFresh → decryptFreshBundle | 输出 = 原始 UnityFS |
| 5 | `fresh KHFS → decrypt in Studio` | 同上 + loadAssetBundle | 能正常解析资产 |
| 6 | `fresh KHNFS → decrypt` | encryptUnityFsToKhFresh(sig='UnityKHNFS') → isFreshBundle | 返回 true，decryptFreshBundle 正确 |
| 7 | `fresh KH1FS → decrypt` | encryptUnityFsToKhFresh(sig='UnityKH1FS') → isFreshBundle | 返回 true，decryptFreshBundle 正确 |
| 8 | `real KHFS file roundtrip` | 读取 `110943700.assetbundle` 和 `4087659059.assetbundle` → decrypt → encrypt | 输出 = 原始文件，两个文件互相验证 |
| 9 | `modified data roundtrip` | 修改解密后的 UnityFS → encryptKhBundle → decrypt | 修改体现在输出中 |
| 10 | `isKhBundle detects formats` | 传入三种格式的 header + 无效数据 | 正确返回 true/false |
| 11 | `isFreshBundle detection` | 传入 fresh 加密文件和 round-trip 加密文件 | fresh 返回 true，round-trip 返回 false |
| 12 | `eRot=0 edge case` | c 值使得 eRot=0 的 KH1FS 文件 | 不崩溃，round-trip 正确 |
| 13 | `empty tail` | c = 整个数据长度，tail=0 | round-trip 正确 |
| 14 | `xorDecrypt correctness` | 已知明文 + 密钥 | 与 Python 脚本结果一致 |

#### 3.3 辅助函数

测试文件中内置 `buildMockKhBundle()` 函数，构造指定格式的模拟 KH 文件：

```typescript
function buildMockKhBundle(signature: string, dataLen: number): ArrayBuffer {
  // 构建: magic(null-term) + o(31) + s(12, s[0:4]=c) + flags(11/12) + encrypted_data(c)
  // 使用随机数据作为加密内容
}
```

---

### 4. 运行测试

```bash
# 一次性运行
npm test

# 持续监视模式
npm run test:watch
```

---

## 假设与决策

1. **选择 Vitest 而非 Jest**：因为项目使用 Vite，Vitest 无需额外配置即可使用 `@` 别名、TypeScript 等，且运行速度更快。
2. **测试放在 `src/utils/__tests__/`**：遵循 Vue/Vite 项目惯例，与源码同目录。
3. **仅测试 khDecrypt/khEncrypt**：这两个模块是纯算法、零依赖，最适合自动化测试。不涉及 Vue 组件测试（那需要额外的 jsdom 或浏览器环境）。
4. **FRESH_MARKER 方案**：当前代码使用 FRESH_MARKER 标记新鲜加密，测试需覆盖此路径。

---

## 验证步骤

1. `npm install -D vitest` 安装成功
2. `npm test` 所有 14 个测试用例通过
3. 修改 `khDecrypt.ts` 引入一个已知错误（如改密钥），确认至少一个测试失败
4. 恢复错误，确认测试重新通过
