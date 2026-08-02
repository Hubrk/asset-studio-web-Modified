# Asset Studio Web — 技术诊断与团队提升计划

> 资深开发工程师(高级开发工程师)出具 | 2026-08-02
> 范围:仓库卫生、架构质量、CI 门禁、构建性能、功能/体验/执行效率

## 0. 结论速览

这是一个**架构功底不错的本地优先 Web 工具**:Vue 3 + TS + Vite 8 + Pinia,重型解析/导出逻辑正确地放在 Comlink Web Worker 中,核心解密算法(`src/utils/khDecrypt.ts`)注释完善、单测覆盖到位。

但**工程卫生与质量门禁是明显短板**:根目录堆积了 41 个逆向探索草稿、2 个 682KB 的疑似构建产物、54KB 的临时清单,且 `.gitignore` 未忽略它们;文档与实际代码存在漂移;**没有 CI 质量门禁**;重型依赖(尤其 Monaco)被静态打包拖慢首屏。

一句话:**代码内核健康,工程外围失序**。提升团队能力应从"止血(仓库+CI)+ 性能(分包)+ 功能(产品化已有算法)"三步走。

## 1. 技术栈与架构

- 前端:Vue 3.5 + Pinia 3 + Element Plus + vxe-table;构建 Vite 8(rolldown)+ TypeScript 6
- 核心解析:本地包 `@local/unity-js`(fork 自 `@arkntools/unity-js`),已扩展写入/重加密能力
- 重型计算:Comlink Web Worker(`assetManager` / `imageConverter`)+ WASM(TFJS、ONNX、lame-wasm、unity-js-tools-wasm)+ lz4
- 能力:PWA 离线、File System Access API、国际化(zh/en)、暗色模式、Monaco 编辑器、Spine 播放、批量工作流

分层(自顶向下):UI 组件 → Pinia 状态 → Web Worker(Comlink)→ `@local/unity-js` 引擎 → WASM/重型计算 → 存储(IndexedDB / FS Access / PWA 缓存)。

## 2. 现状评估

| 维度 | 状态 | 说明 |
|---|---|---|
| 架构分层 | ✅ 良好 | UI/状态/Worker/引擎/WASM 分层清晰,重型任务正确入 Worker |
| 核心算法质量 | ✅ 良好 | `khDecrypt.ts` 注释详尽,15 个单测覆盖加解密往返 |
| 工具链 | ✅ 良好 | ESLint + Prettier + AutoImport + Icons + PWA 齐全 |
| 仓库卫生 | ❌ 严重 | 根目录 41 个 `.py/.js` 草稿 + 2×682KB 产物 + `.tmp_files.json`,`.gitignore` 未忽略 |
| 文档一致性 | ⚠️ 漂移 | `PROJECT_OVERVIEW.md` 称用 Vue Router,但依赖里没有;疑似 AI 生成未与代码核对 |
| CI 质量门禁 | ❌ 缺失 | 仅 `pages-deploy.yml`,无 type-check / lint / test 门禁 |
| 构建性能 | ⚠️ 隐患 | `chunkSizeWarningLimit` 抬到 5MB 却无 `manualChunks`;Monaco/ONNX/TFJS 静态打包 |
| 版本控制 | ⚠️ 未初始化 | 当前工作副本无 `.git`,无法体现分支/PR 纪律 |

## 3. 优化方向(对应你的四个问题)

### 3.1 工程卫生与仓库治理(地基)
- 清理根目录:把 41 个逆向草稿移到独立 `research/` 仓库或归档,不要进主仓
- 删除/移走根目录 `index.js`、`kh_decrypt.js`(各 682KB,疑似误放的构建产物;源码早已用 `src/utils/khDecrypt.ts`)
- 把 6 个 `.assetbundle` 样本归入 `tests/fixtures/`
- 补全 `.gitignore`(已有 node_modules/dist,需加 `*.assetbundle`、`scratch/`、`.tmp_*` 等)
- 统一运行时:README 用 bun,但仓库是 npm / package-lock —— 择一,避免 lock 漂移

### 3.2 质量门禁与 CI(提升技术能力的关键)
- 新增 CI:push/PR 跑 `type-check`(vue-tsc)+ `lint`(eslint)+ `test`(vitest)
- 加覆盖率门槛(核心 crypto / loader ≥ 80%)
- 引入 PR 模板 + 自检清单(破坏性变更、性能回归、i18n)
- 文档即代码:用架构 ADR + CONTRIBUTING 取代会漂移的总览文档

### 3.3 构建 / 加载性能(执行效率之一)
- `vite.config.ts` 增加 `build.rollupOptions.output.manualChunks`,按 vendor 拆分(ep / monaco / vxe / tfjs / onnx / unity-js)
- **动态导入重型依赖**:Monaco、ONNX、TFJS 改为 `import()` 按需加载(目前静态打包,首屏巨大)
- 启用 `build.cssCodeSplit`
- 首屏加骨架屏 / 进度态,避免白屏

### 3.4 代码质量与可维护性
- 现状已不错;建议补:组件/集成测试(cypress 配置已留痕但无用例)、loader 层单测、bundle 解析单测
- 抽离魔法数字(解密常量集中到一处)、统一错误文案
- 用 `transfer` / 零拷贝优化大块二进制在 Worker 间的传递(目前部分走拷贝)

### 3.5 可添加的功能(功能扩展)
- **批量重加密 / 回写 UI**:已有 `khEncrypt.ts` + 往返测试,但**无界面入口** → 把"改完再加密回 UnityKHFS"做成工作流
- **Bundle 对比(diff)**:根目录草稿有 compare 逻辑,产品化为"两版本资源差异视图"
- **命令面板(Cmd+K)**:给高级用户快速跳转 / 操作
- **预览缩略图网格 + 虚拟滚动**:大资源列表用 vxe 虚拟化,缩略图懒加载
- **项目 / 最近文件历史**:已用 idb-keyval,做成可恢复的工作区
- **导出预设**:保存常用导出配置(格式 / 命名规则 / 路径模板)

### 3.6 体验优化(UX)
- 解密失败 / 不支持格式的友好错误态(目前可能直接抛错)
- 暗色模式过渡平滑化 + 主题切换无闪烁
- 键盘可达性 & 焦点管理(WCAG 2.1 AA)
- 大文件加载的流式进度(已有 `ResourceFetchProgress`,可强化)
- 响应式面板布局(工具偏桌面,但侧栏可折叠)

### 3.7 执行效率(运行时性能)
- 解密 / 纹理编码已在 Worker,良好;进一步:用 `crypto.subtle` / WASM 加速大块 XOR
- `decryptKhBundle` 目前整段 `new Uint8Array(totalLen)` 拷贝,超大包双倍内存 → 用单 ArrayBuffer + DataView 原地写,或复用 `splitKhBundle` 的零拷贝思路
- PromisePool 并发控制已就绪,确认大文件下内存上限
- 纹理 mip / 抠图用 wasm 多线程版(ONNX / TFJS threads)

## 4. 分级路线图

- **P0(1–2 周,止血 / 地基)**:仓库清理 + `.gitignore` + 初始化 git + CI 门禁(type-check / lint / test)+ 文档校正
- **P1(2–4 周,性能 / 体验)**:manualChunks + 重型依赖动态导入 + 首屏骨架 + 虚拟滚动 + 无障碍
- **P2(4–8 周,功能扩展)**:批量重加密 UI + Bundle 对比 + 命令面板 + 缩略图网格 + 项目历史

## 5. 给团队的技术能力提升建议

- 建立"架构决策记录(ADR)"机制,重大改动留痕
- 代码评审聚焦:性能回归、Worker 边界、二进制正确性、i18n
- 核心算法强制单测(加解密 / 序列化往返),CI 设覆盖率门
- 文档与代码同 PR 更新,杜绝漂移
- 双周技术分享:Worker / 内存零拷贝、WASM 集成、Vite 分包等

## 6. 建议的第一步

从 **P0 的"仓库清理 + CI 门禁"** 入手:半天即可把根目录草稿归档、补 `.gitignore`、加一个最小 CI workflow。需要的话我可以直接帮你执行这一步(创建 `research/` 归档、清理根目录、写 `.gitignore` 与 CI 配置)。
