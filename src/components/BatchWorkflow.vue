<template>
  <el-dialog
    v-model="visible"
    title="批量工作流"
    width="80%"
    top="5vh"
    :close-on-click-modal="false"
    :close-on-press-escape="!store.isRunning"
    :show-close="!store.isRunning"
    destroy-on-close
  >
    <div class="batch-workflow">
      <el-card shadow="never" class="section-card">
        <template #header>
          <span class="card-title">模式与目录</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="工作模式">
            <el-radio-group v-model="store.mode" :disabled="store.isRunning">
              <el-radio value="replace">替换图工作流</el-radio>
              <el-radio value="exportTextures">导出纹理到 bundle 原目录</el-radio>
              <el-radio value="filterByResolution">按纹理属性筛选导出</el-radio>
              <el-radio value="imageMatchAndCopy">图片匹配复制</el-radio>
              <el-radio value="assetMatchAndCopy">资产匹配复制</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item label="输入目录">
            <div
              class="dir-drop-zone"
              :class="{ 'is-dragover': isDirDragOver }"
              @dragover.prevent="isDirDragOver = true"
              @dragleave="isDirDragOver = false"
              @drop.prevent="handleDropDir"
            >
              <el-button :disabled="store.isRunning" @click="pickInputDir">选择目录</el-button>
              <el-text class="dir-name" :type="store.inputDirHandle ? 'success' : 'info'">
                {{ store.inputDirHandle ? store.inputDirHandle.name : '未选择（可拖拽文件夹到此处）' }}
              </el-text>
              <el-text v-if="store.mode === 'exportTextures' || store.mode === 'filterByResolution'" type="info" class="dir-hint">
                （将递归扫描所有子目录中的 .assetbundle）
              </el-text>
              <el-text v-if="store.mode === 'imageMatchAndCopy'" type="info" class="dir-hint">
                （来源图片文件夹，将扫描其中的图片文件）
              </el-text>
              <el-text v-if="store.mode === 'assetMatchAndCopy'" type="info" class="dir-hint">
                （来源图片文件夹，用于按名称匹配资产文件）
              </el-text>
            </div>
          </el-form-item>

        </el-form>

        <el-alert
          v-if="store.mode === 'replace'"
          type="info"
          :closable="false"
          show-icon
          title="替换图工作流说明"
          description="将图片替换到对应 bundle 的纹理中，输出加密的 KH 文件（_modified 后缀）到 bundle 所在同一目录。图片文件名需包含尺寸信息（如 hero_1024x1024.png）以精确匹配纹理。"
        />
      </el-card>

      <!-- 替换图工作流配置 -->
      <el-card v-if="store.mode === 'replace'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">替换图配置</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="AI 抠图">
            <el-checkbox v-model="store.enableRemoveBg" :disabled="store.isRunning">
              启用
            </el-checkbox>
            <el-select
              v-model="store.removeBgModelType"
              size="small"
              style="width: 180px"
              :disabled="store.isRunning"
            >
              <el-option label="RMBG-1.4 (ONNX)" value="onnx" />
              <el-option label="Removebg 1.6 (TF.js)" value="tfjs" />
              <el-option label="Removebg 1.5 Fast (ONNX)" value="fast" />
            </el-select>
            <el-button
              size="small"
              :disabled="store.isModelReady || isModelLoading"
              :loading="isModelLoading"
              @click="handleInitModel"
            >
              初始化模型
            </el-button>
            <el-text class="model-status" :type="modelStatusType">
              {{ modelStatusText }}
            </el-text>
          </el-form-item>

          <el-form-item v-if="store.enableRemoveBg" label="抠图参数" class="removebg-params">
            <el-input-number
              v-model="store.removeBgThreshold"
              :min="0"
              :max="255"
              :step="1"
              size="small"
              :disabled="store.isRunning"
            />
            <span class="param-label">抠图阈值</span>

            <el-checkbox v-model="store.removeBgFeather" :disabled="store.isRunning">
              边缘羽化
            </el-checkbox>

            <el-input-number
              v-model="store.removeBgMaxSize"
              :min="64"
              :max="4096"
              :step="64"
              size="small"
              :disabled="store.isRunning"
            />
            <span class="param-label">最大处理尺寸</span>
          </el-form-item>

          <el-divider />

          <el-form-item label="目标格式">
            <el-select
              v-model="store.targetFormat"
              :disabled="store.isRunning"
              style="width: 200px"
              placeholder="选择目标格式"
            >
              <el-option
                v-for="opt in formatOptions"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>

            <el-checkbox v-model="store.generateMips" :disabled="store.isRunning">
              生成 Mipmaps
            </el-checkbox>
            <el-select
              v-model="assetManager.sharpen"
              :disabled="store.isRunning"
              style="width: 110px"
            >
              <el-option label="不锐化" :value="0" />
              <el-option label="轻度锐化" :value="1" />
              <el-option label="适中锐化" :value="2" />
              <el-option label="较强锐化" :value="3" />
            </el-select>
          </el-form-item>

          <el-form-item label="压缩模式">
            <el-select
              v-model="compressionModeModel"
              :disabled="store.isRunning"
              style="width: 200px"
            >
              <el-option label="不压缩（默认，游戏兼容）" :value="0" />
              <el-option label="LZ4_HC（体积小，兼容游戏）" :value="3" />
              <el-option label="LZ4（体积略大）" :value="2" />
            </el-select>
            <el-text type="info" class="dir-hint">
              写回 bundle 的压缩格式。默认不压缩 + 无损纹理（RGBA32）；游戏加载器只认 LZ4_HC，选压缩时请用 LZ4_HC
            </el-text>
          </el-form-item>

          <el-form-item label="兜底裁剪">
            <el-input-number
              v-model="store.fallbackCropRatio"
              :min="0"
              :max="0.5"
              :step="0.01"
              :precision="2"
              size="small"
              :disabled="store.isRunning"
            />
            <span class="param-label">裁剪比例</span>
            <el-select
              v-model="store.fallbackCropDirection"
              :disabled="store.isRunning"
              size="small"
              style="width: 120px; margin-left: 8px"
            >
              <el-option label="裁下方(留头)" value="bottom" />
              <el-option label="裁上方(留脚)" value="top" />
              <el-option label="居中裁上下" value="center" />
            </el-select>
            <el-checkbox
              v-model="store.universalCrop"
              :disabled="store.isRunning"
              style="margin-left: 12px"
            >
              启用通用裁剪（全部图片都裁）
            </el-checkbox>
          </el-form-item>

          <el-form-item label="匹配后缀">
            <el-input
              v-model="store.matchSuffix"
              :disabled="store.isRunning"
              style="width: 200px"
              placeholder="如 _generated"
              clearable
            />
            <el-text type="info" class="dir-hint">
              图片文件名中需忽略的后缀，如 _generated 表示 hero_1024x1024_generated.png 匹配纹理 hero
            </el-text>
          </el-form-item>

          <el-form-item>
            <el-button
              type="primary"
              :disabled="store.isRunning || isPreviewing"
              :loading="isPreviewing"
              @click="handlePreview"
            >
              预览匹配
            </el-button>
            <el-button
              type="success"
              :disabled="store.isRunning || isPreviewing || !store.tasks.length"
              @click="handleRun"
            >
              开始执行
            </el-button>
            <el-button :disabled="!store.isRunning" @click="store.cancel">取消</el-button>
            <el-button :disabled="store.isRunning" @click="store.reset">重置</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 导出纹理模式配置 -->
      <el-card v-if="store.mode === 'exportTextures'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">导出纹理配置</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="批次大小">
            <el-input-number
              v-model="store.batchSize"
              :min="1"
              :max="500"
              :step="10"
              size="small"
              :disabled="store.isRunning"
            />
            <el-text type="info" class="dir-hint">
              每批处理的 bundle 数量（默认 100，避免内存堆积）
            </el-text>
          </el-form-item>

          <el-form-item label="文件名选项">
            <el-checkbox v-model="store.includeBundleName" :disabled="store.isRunning">
              在文件名中加入 bundle 资产文件名
            </el-checkbox>
            <el-text type="info" class="dir-hint">
              开启后：纹理名_WxH_bundle名.png；关闭时：纹理名_WxH.png
            </el-text>
          </el-form-item>

          <el-form-item>
            <el-button
              type="primary"
              :disabled="store.isRunning || isPreviewing || !store.inputDirHandle"
              :loading="isPreviewing"
              @click="handlePreviewExport"
            >
              扫描并预览
            </el-button>
            <el-button
              type="success"
              :disabled="store.isRunning || isPreviewing || !store.exportTextureTasks.length"
              @click="handleRunExport"
            >
              开始导出
            </el-button>
            <el-button :disabled="!store.isRunning" @click="store.cancel">取消</el-button>
            <el-button :disabled="store.isRunning" @click="store.reset">重置</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="导出说明"
          description="递归扫描输入目录所有 .assetbundle 文件（含子目录），解密后将每个 bundle 内的 Texture2D 资产导出为 PNG，写入 bundle 所在的目录。文件名 = 纹理名.png。按最上层文件夹分批处理，避免内存堆积。"
        />
      </el-card>

      <!-- 按纹理属性筛选导出模式配置 -->
      <el-card v-if="store.mode === 'filterByResolution'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">纹理属性筛选配置</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="目标分辨率">
            <div class="resolution-input-row">
              <el-input
                v-model="resolutionInput"
                placeholder="如 460x500"
                size="small"
                style="width: 160px"
                :disabled="store.isRunning"
                @keyup.enter="handleAddResolution"
              />
              <el-button
                size="small"
                type="primary"
                :disabled="store.isRunning"
                @click="handleAddResolution"
              >
                添加
              </el-button>
              <el-button
                size="small"
                :disabled="store.isRunning || !store.filterResolutions.length"
                @click="store.clearResolutions"
              >
                清空
              </el-button>
            </div>
          </el-form-item>

          <el-form-item v-if="store.filterResolutions.length" label="已添加">
            <div class="resolution-tags">
              <el-tag
                v-for="(res, idx) in store.filterResolutions"
                :key="res"
                closable
                :disable-transitions="false"
                :disabled="store.isRunning"
                @close="store.removeResolution(idx)"
              >
                {{ res }}
              </el-tag>
            </div>
          </el-form-item>

          <el-form-item label="纹理名称">
            <div class="resolution-input-row">
              <el-input
                v-model="textureNameInput"
                placeholder="如 hero、icon"
                size="small"
                style="width: 200px"
                :disabled="store.isRunning"
                @keyup.enter="handleAddTextureName"
              />
              <el-button
                size="small"
                type="primary"
                :disabled="store.isRunning"
                @click="handleAddTextureName"
              >
                添加
              </el-button>
              <el-button
                size="small"
                :disabled="store.isRunning || !store.filterTextureNames.length"
                @click="store.clearTextureNames"
              >
                清空
              </el-button>
            </div>
          </el-form-item>

          <el-form-item v-if="store.filterTextureNames.length" label="已添加名称">
            <div class="resolution-tags">
              <el-tag
                v-for="(name, idx) in store.filterTextureNames"
                :key="name"
                closable
                :disable-transitions="false"
                :disabled="store.isRunning"
                @close="store.removeTextureName(idx)"
              >
                {{ name }}
              </el-tag>
            </div>
          </el-form-item>

          <el-form-item v-if="store.filterResolutions.length && store.filterTextureNames.length" label="逻辑关系">
            <el-radio-group v-model="logicValue" :disabled="store.isRunning">
              <el-radio-button value="and">与 (同时满足)</el-radio-button>
              <el-radio-button value="or">或 (满足其一)</el-radio-button>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="store.filterTextureNames.length" label="名称匹配模式">
            <el-radio-group v-model="store.filterNameMatchMode" :disabled="store.isRunning" size="small">
              <el-radio value="exact">精确匹配</el-radio>
              <el-radio value="contains">包含匹配</el-radio>
              <el-radio value="regex">正则匹配</el-radio>
            </el-radio-group>
            <el-checkbox
              v-model="store.filterNameCaseInsensitive"
              :disabled="store.isRunning"
              style="margin-left: 12px"
            >
              忽略大小写
            </el-checkbox>
          </el-form-item>

          <el-form-item label="输出目录">
            <div
              class="dir-drop-zone"
              :class="{ 'is-dragover': isFilterOutDragOver }"
              @dragover.prevent="isFilterOutDragOver = true"
              @dragleave="isFilterOutDragOver = false"
              @drop.prevent="handleDropFilterOutDir"
            >
              <el-button :disabled="store.isRunning" @click="pickFilterOutputDir">选择目录</el-button>
              <el-text class="dir-name" :type="store.filterOutputDirHandle ? 'success' : 'info'">
                {{ store.filterOutputDirHandle ? store.filterOutputDirHandle.name : '未选择（可拖拽文件夹到此处）' }}
              </el-text>
            </div>
          </el-form-item>

          <el-form-item label="导出选项">
            <el-checkbox v-model="store.exportOriginalBundle" :disabled="store.isRunning">
              同时导出原始 bundle 文件
            </el-checkbox>
          </el-form-item>

          <el-form-item label="文件名选项">
            <el-checkbox v-model="store.includeBundleName" :disabled="store.isRunning">
              在文件名中加入 bundle 资产文件名
            </el-checkbox>
            <el-text type="info" class="dir-hint">
              开启后：纹理名_WxH_bundle名.png；关闭时：纹理名_WxH.png
            </el-text>
          </el-form-item>

          <el-form-item label="批次大小">
            <el-input-number
              v-model="store.batchSize"
              :min="1"
              :max="500"
              :step="10"
              size="small"
              :disabled="store.isRunning"
            />
            <el-text type="info" class="dir-hint">
              每批处理的 bundle 数量（默认 100，避免内存堆积）
            </el-text>
          </el-form-item>

          <el-form-item>
            <el-button
              type="primary"
              :disabled="store.isRunning || isPreviewing || !store.inputDirHandle || (!store.filterResolutions.length && !store.filterTextureNames.length)"
              :loading="isPreviewing"
              @click="handlePreviewFilter"
            >
              扫描并预览
            </el-button>
            <el-button
              type="success"
              :disabled="store.isRunning || isPreviewing || !store.filterResolutionTasks.length || !store.filterOutputDirHandle"
              @click="handleRunFilter"
            >
              开始导出
            </el-button>
            <el-button :disabled="!store.isRunning" @click="store.cancel">取消</el-button>
            <el-button :disabled="store.isRunning" @click="store.reset">重置</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="分辨率筛选说明"
          description="递归扫描输入目录所有 .assetbundle，加载每个 bundle 提取其中 Texture2D 的实际分辨率（width × height）和纹理名称。可单独按分辨率或纹理名称筛选，也可两者组合用「与/或」逻辑关系控制。匹配的纹理导出为 PNG 到指定输出目录。勾选「同时导出原始 bundle 文件」时，会将匹配的 bundle 原文件也复制到输出目录。按最上层文件夹分批加载，避免内存堆积。"
        />
      </el-card>

      <!-- 图片匹配复制模式配置 -->
      <el-card v-if="store.mode === 'imageMatchAndCopy'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">图片匹配配置</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="搜索目录">
            <div
              class="dir-drop-zone"
              :class="{ 'is-dragover': isImageMatchSearchDragOver }"
              @dragover.prevent="isImageMatchSearchDragOver = true"
              @dragleave="isImageMatchSearchDragOver = false"
              @drop.prevent="handleDropImageMatchSearchDir"
            >
              <el-button :disabled="store.isRunning" @click="pickImageMatchSearchDir">选择目录</el-button>
              <el-text class="dir-name" :type="store.imageMatchSearchDirHandle ? 'success' : 'info'">
                {{ store.imageMatchSearchDirHandle ? store.imageMatchSearchDirHandle.name : '未选择（可拖拽文件夹到此处）' }}
              </el-text>
            </div>
          </el-form-item>

          <el-form-item label="输出目录">
            <div
              class="dir-drop-zone"
              :class="{ 'is-dragover': isImageMatchOutDragOver }"
              @dragover.prevent="isImageMatchOutDragOver = true"
              @dragleave="isImageMatchOutDragOver = false"
              @drop.prevent="handleDropImageMatchOutputDir"
            >
              <el-button :disabled="store.isRunning" @click="pickImageMatchOutputDir">选择目录</el-button>
              <el-text class="dir-name" :type="store.imageMatchOutputDirHandle ? 'success' : 'info'">
                {{ store.imageMatchOutputDirHandle ? store.imageMatchOutputDirHandle.name : '未选择（可拖拽文件夹到此处）' }}
              </el-text>
            </div>
          </el-form-item>

          <el-form-item label="匹配模式">
            <el-radio-group v-model="store.imageMatchMode" :disabled="store.isRunning" size="small">
              <el-radio value="exact">精确匹配</el-radio>
              <el-radio value="contains">包含匹配</el-radio>
              <el-radio value="regex">正则匹配</el-radio>
            </el-radio-group>
            <el-checkbox
              v-model="store.imageMatchCaseInsensitive"
              :disabled="store.isRunning"
              style="margin-left: 12px"
            >
              忽略大小写
            </el-checkbox>
          </el-form-item>
          <el-form-item v-if="store.imageMatchMode === 'regex'" label="正则表达式">
            <el-input
              v-model="store.imageMatchRegexPattern"
              placeholder="如 hero\\d+"
              size="small"
              style="width: 240px"
              :disabled="store.isRunning"
            />
          </el-form-item>
          <el-form-item label="输出后缀">
            <el-input
              v-model="store.imageMatchSuffix"
              placeholder="_copied"
              size="small"
              style="width: 160px"
              :disabled="store.isRunning"
            />
            <el-text type="info" class="dir-hint">
              匹配到的文件将重命名为「原名+后缀.扩展名」（如 90415_copied.png）
            </el-text>
          </el-form-item>

          <el-form-item>
            <el-button
              type="primary"
              :disabled="store.isRunning || !store.inputDirHandle || !store.imageMatchSearchDirHandle"
              :loading="store.isRunning && store.imageMatchTasks.length === 0"
              @click="handlePreviewImageMatch"
            >
              预览匹配
            </el-button>
            <el-button
              type="success"
              :disabled="store.isRunning || !store.imageMatchTasks.length || !store.imageMatchOutputDirHandle"
              @click="handleRunImageMatch"
            >
              开始复制
            </el-button>
            <el-button :disabled="!store.isRunning" @click="store.cancel">取消</el-button>
            <el-button :disabled="store.isRunning" @click="store.reset">重置</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="图片匹配复制说明"
          description="扫描输入目录中所有图片，在搜索目录中查找同名图片，匹配到的图片复制到输出目录并添加指定后缀。支持精确匹配、包含匹配、正则匹配和忽略大小写。"
        />
      </el-card>

      <!-- 资产匹配复制模式配置 -->
      <el-card v-if="store.mode === 'assetMatchAndCopy'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">资产匹配配置</span>
        </template>

        <el-form label-position="left" label-width="auto" class="config-form">
          <el-form-item label="资产库目录">
            <div
              class="dir-drop-zone"
              :class="{ 'is-dragover': isAssetMatchSearchDragOver }"
              @dragover.prevent="isAssetMatchSearchDragOver = true"
              @dragleave="isAssetMatchSearchDragOver = false"
              @drop.prevent="handleDropAssetMatchSearchDir"
            >
              <el-button :disabled="store.isRunning" @click="pickAssetMatchSearchDir">选择目录</el-button>
              <el-text class="dir-name" :type="store.assetMatchSearchDirHandle ? 'success' : 'info'">
                {{ store.assetMatchSearchDirHandle ? store.assetMatchSearchDirHandle.name : '未选择（可拖拽文件夹到此处）' }}
              </el-text>
            </div>
          </el-form-item>

          <el-form-item>
            <el-button
              type="primary"
              :disabled="store.isRunning || !store.inputDirHandle || !store.assetMatchSearchDirHandle"
              :loading="store.isRunning && store.assetMatchTasks.length === 0"
              @click="handlePreviewAssetMatch"
            >
              预览匹配
            </el-button>
            <el-button
              type="success"
              :disabled="store.isRunning || !store.assetMatchTasks.length || !store.inputDirHandle"
              @click="handleRunAssetMatch"
            >
              开始复制
            </el-button>
            <el-button :disabled="!store.isRunning" @click="store.cancel">取消</el-button>
            <el-button :disabled="store.isRunning" @click="store.reset">重置</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="资产匹配复制说明"
          description="递归扫描输入目录中所有图片，在资产库目录中递归查找同名图片（去掉扩展名和结尾的_宽x高后缀后比较），匹配到后将该图片所在文件夹中的所有 .assetbundle 文件复制到来源图片所在的目录中（原文件保留不动）。"
        />
      </el-card>

      <el-card shadow="never" class="section-card">
        <template #header>
          <span class="card-title">进度</span>
        </template>
        <div class="progress-section">
          <el-progress
            :percentage="Math.round(store.totalProgress * 100)"
            :status="progressStatus"
          />
          <el-text class="progress-text">
            {{ Math.round(store.totalProgress * 100) }}%
            <template v-if="store.currentTaskIndex >= 0">
              ({{ store.currentTaskIndex + 1 }}/{{ currentTaskTotal }})
            </template>
            <template v-if="store.mode !== 'replace' && store.totalBatchCount > 0 && store.isRunning">
              · 批次 {{ store.currentBatchIndex + 1 }}/{{ store.totalBatchCount }}
            </template>
          </el-text>
        </div>
        <el-text class="stage-text" type="info">{{ store.stageText || '空闲' }}</el-text>
      </el-card>

      <el-card v-if="store.mode === 'replace'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">匹配结果 ({{ store.tasks.length }})</span>
        </template>
        <el-table
          :data="store.tasks"
          height="320"
          size="small"
          border
          :row-class-name="rowClassName"
        >
          <el-table-column prop="bundleFileName" label="Bundle" min-width="140" show-overflow-tooltip />
          <el-table-column prop="imageName" label="图片" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.imageName }}
              <el-tag v-if="row.isFallback" type="warning" size="small" style="margin-left: 4px">兜底</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="textureName" label="纹理" min-width="120" show-overflow-tooltip />
          <el-table-column label="PathID" width="120">
            <template #default="{ row }">
              {{ String(row.pathId) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.error" class="error-text">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-row :gutter="16" class="unmatched-section">
          <el-col :span="12">
            <el-text tag="p" class="unmatched-title">未匹配图片 ({{ store.unmatchedImages.length }})</el-text>
            <el-scrollbar height="120" class="unmatched-list">
              <ul>
                <li v-for="name in store.unmatchedImages" :key="name">{{ name }}</li>
              </ul>
            </el-scrollbar>
          </el-col>
          <el-col :span="12">
            <el-text tag="p" class="unmatched-title">未匹配纹理 ({{ store.unmatchedTextures.length }})</el-text>
            <el-scrollbar height="120" class="unmatched-list">
              <ul>
                <li v-for="name in store.unmatchedTextures" :key="name">{{ name }}</li>
              </ul>
            </el-scrollbar>
          </el-col>
        </el-row>
      </el-card>

      <el-card v-else-if="store.mode === 'exportTextures'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">导出任务 ({{ store.exportTextureTasks.length }})</span>
        </template>
        <el-table
          :data="store.exportTextureTasks"
          height="400"
          size="small"
          border
          :row-class-name="rowClassName"
        >
          <el-table-column prop="bundleRelPath" label="Bundle 路径" min-width="220" show-overflow-tooltip />
          <el-table-column prop="textureName" label="纹理名" min-width="140" show-overflow-tooltip />
          <el-table-column prop="exportFileName" label="导出文件名" min-width="160" show-overflow-tooltip />
          <el-table-column label="PathID" width="120">
            <template #default="{ row }">
              {{ String(row.pathId) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.error" class="error-text">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-if="store.mode === 'filterByResolution'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">筛选结果 ({{ store.filterResolutionTasks.length }})</span>
        </template>
        <el-table
          :data="store.filterResolutionTasks"
          height="400"
          size="small"
          border
          :row-class-name="rowClassName"
        >
          <el-table-column prop="bundleRelPath" label="Bundle 路径" min-width="220" show-overflow-tooltip />
          <el-table-column prop="textureName" label="纹理名" min-width="140" show-overflow-tooltip />
          <el-table-column prop="resolution" label="分辨率" width="100" />
          <el-table-column prop="exportFileName" label="导出文件名" min-width="160" show-overflow-tooltip />
          <el-table-column label="PathID" width="120">
            <template #default="{ row }">
              {{ String(row.pathId) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.error" class="error-text">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-if="store.mode === 'imageMatchAndCopy'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">匹配结果 ({{ store.imageMatchTasks.length }})</span>
        </template>
        <el-table
          :data="store.imageMatchTasks"
          height="400"
          size="small"
          border
          :row-class-name="rowClassName"
        >
          <el-table-column prop="sourceFileName" label="来源图片" min-width="180" show-overflow-tooltip />
          <el-table-column prop="matchedFileName" label="匹配到的文件" min-width="180" show-overflow-tooltip />
          <el-table-column prop="outputFileName" label="输出文件名" min-width="180" show-overflow-tooltip />
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.error" class="error-text">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          v-if="store.imageMatchUnmatched.length"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 12px"
          title="未匹配的图片"
          :description="store.imageMatchUnmatched.join(', ')"
        />
      </el-card>

      <el-card v-if="store.mode === 'assetMatchAndCopy'" shadow="never" class="section-card">
        <template #header>
          <span class="card-title">匹配结果 ({{ store.assetMatchTasks.length }})</span>
          <span v-if="store.assetMatchSkipCount > 0" style="margin-left: 8px; font-size: 12px; color: var(--el-color-warning);">
            （已跳过 {{ store.assetMatchSkipCount }} 个重复文件夹）
          </span>
        </template>
        <el-table
          :data="store.assetMatchTasks"
          height="400"
          size="small"
          border
          :row-class-name="rowClassName"
        >
          <el-table-column prop="sourceFileName" label="来源图片" min-width="160" show-overflow-tooltip />
          <el-table-column prop="matchedFolderName" label="匹配文件夹" min-width="140" show-overflow-tooltip />
          <el-table-column prop="matchedImageName" label="匹配到的图片" min-width="160" show-overflow-tooltip />
          <el-table-column label="资产文件数" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="row.bundleCount > 0 ? 'success' : 'danger'">
                {{ row.bundleCount }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="资产文件列表" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.bundleFiles.length">{{ row.bundleFiles.join(', ') }}</span>
              <span v-else class="error-text">无 .assetbundle 文件</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="详情" min-width="160" show-overflow-tooltip>
            <template #default="{ row }">
              <span v-if="row.error" class="error-text">{{ row.error }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-alert
          v-if="store.assetMatchUnmatched.length"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 12px"
          title="未匹配的图片"
          :description="store.assetMatchUnmatched.join(', ')"
        />
      </el-card>

    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { TextureFormat } from '@arkntools/unity-js';
import { useBatchWorkflow } from '@/store/batchWorkflow';
import { useAssetManager } from '@/store/assetManager';
import type { BatchTaskItem, ExportTextureTaskItem, FilterResolutionTaskItem, ImageMatchTaskItem, AssetMatchTaskItem } from '@/store/batchWorkflow';

const store = useBatchWorkflow();
const assetManager = useAssetManager();

/** 写回压缩模式（0=不压缩 默认 | 2=LZ4 | 3=LZ4_HC），选择即同步到全局 + worker */
const compressionModeModel = computed({
  get: () => assetManager.compressionMode,
  set: (v: number) => {
    assetManager.setCompressionMode(v);
  },
});

// 对话框可见性，供 AppHeader 通过 ref.open() 调用
const visible = ref(false);
const open = () => {
  visible.value = true;
};
defineExpose({ open });

const isPreviewing = ref(false);
const isModelLoading = ref(false);
const isDirDragOver = ref(false);
const isFilterOutDragOver = ref(false);
const isImageMatchSearchDragOver = ref(false);
const isImageMatchOutDragOver = ref(false);
const isAssetMatchSearchDragOver = ref(false);
const resolutionInput = ref('');
const textureNameInput = ref('');

// 与/或逻辑关系双向绑定（store 中的 filterLogic）
const logicValue = computed({
  get: () => store.filterLogic,
  set: (v: 'and' | 'or') => store.setFilterLogic(v),
});

// === 目标格式选项 ===
const formatOptions: Array<{ value: TextureFormat | -1; label: string }> = [
  { value: -1, label: '保持原格式' },
  { value: TextureFormat.RGBA32, label: 'RGBA32' },
  { value: TextureFormat.BGRA32, label: 'BGRA32' },
  { value: TextureFormat.DXT1, label: 'DXT1' },
  { value: TextureFormat.DXT5, label: 'DXT5 (BC3)' },
  { value: TextureFormat.BC7, label: 'BC7' },
  { value: TextureFormat.ASTC_RGBA_4x4, label: 'ASTC RGBA 4x4' },
  { value: TextureFormat.ASTC_RGBA_6x6, label: 'ASTC RGBA 6x6' },
  { value: TextureFormat.ASTC_RGBA_8x8, label: 'ASTC RGBA 8x8' },
  { value: TextureFormat.ASTC_RGBA_10x10, label: 'ASTC RGBA 10x10' },
  { value: TextureFormat.ASTC_RGBA_12x12, label: 'ASTC RGBA 12x12' },
];

// 拖拽文件夹识别
const handleDropDir = async (e: DragEvent) => {
  isDirDragOver.value = false;
  if (!e.dataTransfer) return;
  // Chrome 86+ 支持 getAsFileSystemHandle
  for (let i = 0; i < e.dataTransfer.items.length; i++) {
    try {
      const handle = await (e.dataTransfer.items[i] as any).getAsFileSystemHandle?.();
      if (handle && handle.kind === 'directory') {
        store.setInputDir(handle as FileSystemDirectoryHandle);
        return;
      }
    } catch {
      // 忽略
    }
  }
  ElMessage({ message: '请拖入文件夹（不支持拖入文件）', type: 'warning' });
};
const pickInputDir = async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    store.setInputDir(handle);
  } catch (e) {
    // 用户取消选择，忽略
  }
};

// === 模型初始化 ===
const handleInitModel = async () => {
  if (isModelLoading.value) return;
  isModelLoading.value = true;
  try {
    await store.initRemoveBgModel();
    ElMessage({ message: 'AI 抠图模型已就绪', type: 'success' });
  } catch (e) {
    ElMessage({ message: `模型初始化失败：${e}`, type: 'error' });
  } finally {
    isModelLoading.value = false;
  }
};

const modelStatusText = computed(() => {
  if (store.isModelReady) return '状态：已就绪';
  if (isModelLoading.value) {
    const pct = Math.round(store.modelLoadProgress * 100);
    return `状态：加载中 ${pct}%`;
  }
  return '状态：未初始化';
});

const modelStatusType = computed<'success' | 'info' | 'warning'>(() => {
  if (store.isModelReady) return 'success';
  if (isModelLoading.value) return 'warning';
  return 'info';
});

// === 预览匹配 ===
const handlePreview = async () => {
  if (isPreviewing.value) return;
  isPreviewing.value = true;
  try {
    await store.previewMatch();
  } finally {
    isPreviewing.value = false;
  }
};

// === 开始执行 ===
const handleRun = async () => {
  try {
    await store.run();
    const doneCount = store.tasks.filter(t => t.status === 'done').length;
    const errorCount = store.tasks.filter(t => t.status === 'error').length;
    const skippedCount = store.tasks.filter(t => t.status === 'skipped').length;
    ElMessage({
      message: `批量处理完成：成功 ${doneCount}，失败 ${errorCount}，跳过 ${skippedCount}`,
      type: errorCount > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    ElMessage({ message: `批量处理失败：${e}`, type: 'error' });
  }
};

// === 导出纹理模式：扫描预览 ===
const handlePreviewExport = async () => {
  if (isPreviewing.value) return;
  isPreviewing.value = true;
  try {
    await store.previewExportTextures();
    ElMessage({
      message: `扫描完成：${store.exportTextureTasks.length} 个纹理待导出`,
      type: 'info',
    });
  } catch (e) {
    ElMessage({ message: `扫描失败：${e}`, type: 'error' });
  } finally {
    isPreviewing.value = false;
  }
};

// === 导出纹理模式：开始导出 ===
const handleRunExport = async () => {
  try {
    await store.runExportTextures();
    const tasks = store.exportTextureTasks;
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const errorCount = tasks.filter(t => t.status === 'error').length;
    const skippedCount = tasks.filter(t => t.status === 'skipped').length;
    ElMessage({
      message: `导出完成：成功 ${doneCount}，失败 ${errorCount}，跳过 ${skippedCount}`,
      type: errorCount > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    ElMessage({ message: `导出失败：${e}`, type: 'error' });
  }
};

// === 分辨率筛选模式：添加分辨率 ===
const handleAddResolution = () => {
  if (!resolutionInput.value.trim()) return;
  const ok = store.addResolution(resolutionInput.value);
  if (ok) {
    resolutionInput.value = '';
  } else {
    ElMessage({ message: '分辨率格式无效或已存在（如 460x500）', type: 'warning' });
  }
};

// === 分辨率筛选模式：添加纹理名称 ===
const handleAddTextureName = () => {
  if (!textureNameInput.value.trim()) return;
  const ok = store.addTextureName(textureNameInput.value);
  if (ok) {
    textureNameInput.value = '';
  } else {
    ElMessage({ message: '纹理名称为空或已存在', type: 'warning' });
  }
};

// === 分辨率筛选模式：选择输出目录 ===
const pickFilterOutputDir = async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    store.setFilterOutputDir(handle);
  } catch {
    // 用户取消
  }
};

// === 分辨率筛选模式：拖拽输出目录 ===
const handleDropFilterOutDir = async (e: DragEvent) => {
  isFilterOutDragOver.value = false;
  if (!e.dataTransfer) return;
  for (let i = 0; i < e.dataTransfer.items.length; i++) {
    try {
      const handle = await (e.dataTransfer.items[i] as any).getAsFileSystemHandle?.();
      if (handle && handle.kind === 'directory') {
        store.setFilterOutputDir(handle as FileSystemDirectoryHandle);
        return;
      }
    } catch {
      // 忽略
    }
  }
  ElMessage({ message: '请拖入文件夹（不支持拖入文件）', type: 'warning' });
};

// === 分辨率筛选模式：扫描预览 ===
const handlePreviewFilter = async () => {
  if (isPreviewing.value) return;
  isPreviewing.value = true;
  try {
    await store.previewFilterByResolution();
    ElMessage({
      message: `扫描完成：${store.filterResolutionTasks.length} 个纹理匹配`,
      type: 'info',
    });
  } catch (e) {
    ElMessage({ message: `扫描失败：${e}`, type: 'error' });
  } finally {
    isPreviewing.value = false;
  }
};

// === 分辨率筛选模式：开始导出 ===
const handleRunFilter = async () => {
  try {
    await store.runFilterByResolution();
    const tasks = store.filterResolutionTasks;
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const errorCount = tasks.filter(t => t.status === 'error').length;
    const skippedCount = tasks.filter(t => t.status === 'skipped').length;
    ElMessage({
      message: `筛选导出完成：成功 ${doneCount}，失败 ${errorCount}，跳过 ${skippedCount}`,
      type: errorCount > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    ElMessage({ message: `筛选导出失败：${e}`, type: 'error' });
  }
};

// 当前模式下的任务总数（用于进度显示）
const currentTaskTotal = computed(() => {
  if (store.mode === 'replace') return store.tasks.length;
  if (store.mode === 'exportTextures') return store.exportTextureTasks.length;
  if (store.mode === 'imageMatchAndCopy') return store.imageMatchTasks.length;
  if (store.mode === 'assetMatchAndCopy') return store.assetMatchTasks.length;
  return store.filterResolutionTasks.length;
});

// === 图片匹配复制模式 ===

const pickImageMatchSearchDir = async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    store.setImageMatchSearchDir(handle);
  } catch {
    // 用户取消
  }
};

const handleDropImageMatchSearchDir = async (e: DragEvent) => {
  isImageMatchSearchDragOver.value = false;
  if (!e.dataTransfer) return;
  for (let i = 0; i < e.dataTransfer.items.length; i++) {
    try {
      const handle = await (e.dataTransfer.items[i] as any).getAsFileSystemHandle?.();
      if (handle && handle.kind === 'directory') {
        store.setImageMatchSearchDir(handle as FileSystemDirectoryHandle);
        return;
      }
    } catch {
      // 忽略
    }
  }
  ElMessage({ message: '请拖入文件夹（不支持拖入文件）', type: 'warning' });
};

const pickImageMatchOutputDir = async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    store.setImageMatchOutputDir(handle);
  } catch {
    // 用户取消
  }
};

const handleDropImageMatchOutputDir = async (e: DragEvent) => {
  isImageMatchOutDragOver.value = false;
  if (!e.dataTransfer) return;
  for (let i = 0; i < e.dataTransfer.items.length; i++) {
    try {
      const handle = await (e.dataTransfer.items[i] as any).getAsFileSystemHandle?.();
      if (handle && handle.kind === 'directory') {
        store.setImageMatchOutputDir(handle as FileSystemDirectoryHandle);
        return;
      }
    } catch {
      // 忽略
    }
  }
  ElMessage({ message: '请拖入文件夹（不支持拖入文件）', type: 'warning' });
};

const handlePreviewImageMatch = async () => {
  try {
    await store.previewImageMatch();
  } catch (e) {
    ElMessage({ message: `预览扫描失败：${e}`, type: 'error' });
  }
};

const handleRunImageMatch = async () => {
  try {
    await store.runImageMatch();
    const tasks = store.imageMatchTasks;
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const errorCount = tasks.filter(t => t.status === 'error').length;
    ElMessage({
      message: skipCount > 0 ? `复制完成：成功 ${doneCount}，失败 ${errorCount}，跳过 ${skipCount} 个重复文件夹` : `复制完成：成功 ${doneCount}，失败 ${errorCount}`,
      type: errorCount > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    ElMessage({ message: `复制失败：${e}`, type: 'error' });
  }
};

// === 资产匹配移动模式 ===

const pickAssetMatchSearchDir = async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    store.setAssetMatchSearchDir(handle);
  } catch {
    // 用户取消
  }
};

const handleDropAssetMatchSearchDir = async (e: DragEvent) => {
  isAssetMatchSearchDragOver.value = false;
  if (!e.dataTransfer) return;
  for (let i = 0; i < e.dataTransfer.items.length; i++) {
    try {
      const handle = await (e.dataTransfer.items[i] as any).getAsFileSystemHandle?.();
      if (handle && handle.kind === 'directory') {
        store.setAssetMatchSearchDir(handle as FileSystemDirectoryHandle);
        return;
      }
    } catch {
      // 忽略
    }
  }
  ElMessage({ message: '请拖入文件夹（不支持拖入文件）', type: 'warning' });
};

const handlePreviewAssetMatch = async () => {
  try {
    await store.previewAssetMatch();
  } catch (e) {
    ElMessage({ message: `预览扫描失败：${e}`, type: 'error' });
  }
};

const handleRunAssetMatch = async () => {
  try {
    await store.runAssetMatchCopy();
    const tasks = store.assetMatchTasks;
    const doneCount = tasks.filter(t => t.status === 'done').length;
    const errorCount = tasks.filter(t => t.status === 'error').length;
    const skipCount = store.assetMatchSkipCount;
    ElMessage({
      message: `复制完成：成功 ${doneCount}，失败 ${errorCount}`,
      type: errorCount > 0 ? 'warning' : 'success',
    });
  } catch (e) {
    ElMessage({ message: `复制失败：${e}`, type: 'error' });
  }
};

// === 状态显示辅助 ===
type AnyTaskStatus = BatchTaskItem['status'] | ExportTextureTaskItem['status'] | FilterResolutionTaskItem['status'] | ImageMatchTaskItem['status'] | AssetMatchTaskItem['status'];

const statusTagType = (status: AnyTaskStatus) => {
  switch (status) {
    case 'done':
      return 'success';
    case 'error':
      return 'danger';
    case 'pending':
    case 'skipped':
      return 'info';
    default:
      // loading / removebg / encoding / writing / exporting
      return 'warning';
  }
};

const statusLabel = (status: AnyTaskStatus) => {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'loading':
      return '读取中';
    case 'removebg':
      return '抠图中';
    case 'encoding':
      return '编码中';
    case 'writing':
      return '写入中';
    case 'exporting':
      return '导出中';
    case 'copying':
      return '复制中';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    case 'skipped':
      return '跳过';
  }
};

const rowClassName = ({ row }: { row: { status: AnyTaskStatus } }) => {
  if (row.status === 'error') return 'row-error';
  if (row.status === 'done') return 'row-done';
  return '';
};

const progressStatus = computed<'success' | 'warning' | undefined>(() => {
  if (store.totalProgress >= 1) {
    let hasError = false;
    if (store.mode === 'replace') {
      hasError = store.tasks.some(t => t.status === 'error');
    } else if (store.mode === 'exportTextures') {
      hasError = store.exportTextureTasks.some(t => t.status === 'error');
    } else if (store.mode === 'imageMatchAndCopy') {
      hasError = store.imageMatchTasks.some(t => t.status === 'error');
    } else if (store.mode === 'assetMatchAndCopy') {
      hasError = store.assetMatchTasks.some(t => t.status === 'error');
    } else {
      hasError = store.filterResolutionTasks.some(t => t.status === 'error');
    }
    return hasError ? 'warning' : 'success';
  }
  return undefined;
});
</script>

<style lang="scss" scoped>
.batch-workflow {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-card {
  flex-shrink: 0;

  :deep(.el-card__header) {
    padding: 10px 16px;
  }

  :deep(.el-card__body) {
    padding: 14px 16px;
  }
}

.card-title {
  font-weight: 600;
  font-size: 14px;
}

.config-form {
  .dir-drop-zone {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 10px;
    border: 2px dashed transparent;
    border-radius: 6px;
    transition: border-color 0.2s, background-color 0.2s;

    &.is-dragover {
      border-color: var(--el-color-primary);
      background-color: var(--el-color-primary-light-9);
    }
  }

  .dir-name {
    margin-left: 8px;
  }

  .dir-hint {
    margin-left: 8px;
    font-size: 12px;
  }

  .model-status {
    margin-left: 12px;
  }

  .removebg-params {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;

    .param-label {
      margin-left: 4px;
      margin-right: 8px;
      color: var(--el-text-color-secondary);
      font-size: 13px;
    }
  }

  .resolution-input-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .resolution-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
}

.progress-section {
  display: flex;
  align-items: center;
  gap: 12px;

  :deep(.el-progress) {
    flex: 1;
  }

  .progress-text {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--el-text-color-regular);
  }
}

.stage-text {
  display: block;
  margin-top: 8px;
  font-size: 13px;
  min-height: 1em;
}

.unmatched-section {
  margin-top: 14px;
}

.unmatched-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 6px;
}

.unmatched-list {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 6px 10px;

  ul {
    margin: 0;
    padding-left: 16px;
  }

  li {
    font-size: 12px;
    line-height: 1.6;
    color: var(--el-text-color-regular);
  }
}

.error-text {
  color: var(--el-color-danger);
  font-size: 12px;
}

:deep(.row-error) {
  background-color: var(--el-color-danger-light-9);
}

:deep(.row-done) {
  background-color: var(--el-color-success-light-9);
}
</style>
