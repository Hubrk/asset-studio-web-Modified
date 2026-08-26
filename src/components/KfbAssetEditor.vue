<template>
  <div class="kfb-asset-editor">
    <div v-if="!decoded" class="kfb-lock">
      <div class="lock-icon">
        <el-icon><Lock /></el-icon>
      </div>
      <div class="lock-title">此 TextAsset 是 KFB 加密的战斗逻辑数据</div>
      <div class="lock-desc">输入 AES-256 Key 解密后即可编辑战斗数值，改完点「应用修改」并到菜单导出加密 AssetBundle。</div>
      <div class="key-row">
        <el-input v-model="keyText" class="key-input" placeholder="留空自动匹配内置 key 库（263 个角色）" clearable :disabled="decoding">
          <template #prepend>Key</template>
        </el-input>
        <el-button type="primary" :loading="decoding" @click="onDecode()">
          {{ decoding ? '解密中…' : '解密并编辑' }}
        </el-button>
      </div>
      <div class="lock-hint">Key 可留空：自动遍历内置 key 库匹配（支持 263 个角色）。首次解密需加载 8.7MB KFB Schema，之后会缓存，请稍候。</div>
    </div>

    <template v-else>
      <div class="toolbar">
        <el-select
          v-if="siblingKfbs.length > 1"
          v-model="switchName"
          size="small"
          filterable
          placeholder="同包 KFB"
          class="sibling-select"
          @change="onSwitchKfb"
        >
          <el-option v-for="s in siblingKfbs" :key="s.key" :value="s.name" :label="s.name" />
        </el-select>
        <span class="asset-name" :title="info?.name">{{ info?.name }}</span>
        <el-divider direction="vertical" />
        <el-button
          size="small"
          :type="refBrokenTargets.length ? 'danger' : 'default'"
          @click="openRefsDrawer"
        >
          <el-icon class="el-icon--left"><Share /></el-icon>引用
          <span v-if="kfbRefs.length" class="ref-badge">{{ kfbRefs.length }}</span>
        </el-button>
        <el-button v-if="hasActorPair" size="small" @click="openSyncDrawer">
          <el-icon class="el-icon--left"><CopyDocument /></el-icon>同步到 {{ pairName }}
        </el-button>
        <el-button size="small" @click="openChainDrawer">
          <el-icon class="el-icon--left"><Connection /></el-icon>技能链
        </el-button>
        <el-divider direction="vertical" />
        <el-radio-group v-model="editMode" size="small">
          <el-radio-button value="skill">技能</el-radio-button>
          <el-radio-button value="combo">连招</el-radio-button>
          <el-radio-button value="semantic">语义 JSON</el-radio-button>
          <el-radio-button value="xml">XML</el-radio-button>
        </el-radio-group>
        <template v-if="editMode !== 'skill' && editMode !== 'combo'">
          <el-divider direction="vertical" />
          <el-button size="small" @click="formatDoc" :disabled="!hasEdits">格式化</el-button>
          <el-button size="small" @click="validateDoc" :disabled="!hasEdits">校验</el-button>
          <span v-if="jsonValid === true" class="ok-hint">✅ 合法</span>
          <span v-else-if="jsonValid === false" class="err-hint">❌ {{ jsonError }}</span>
          <el-divider direction="vertical" />
          <el-button size="small" :type="searchOpen ? 'primary' : 'default'" @click="toggleSearch">🔍 搜索</el-button>
        </template>
        <div v-if="searchOpen" class="search-wrap">
          <input
            ref="searchInput"
            v-model="searchText"
            class="search-input"
            placeholder="关键词"
            @input="runSearch"
            @keyup.enter="nextMatch"
            @keyup.esc="searchOpen = false"
          />
          <span class="search-count">{{ searchMatches.length ? `${searchIndex}/${searchMatches.length}` : '0' }}</span>
          <button class="search-nav" title="上一个" :disabled="!searchMatches.length" @click="prevMatch">↑</button>
          <button class="search-nav" title="下一个" :disabled="!searchMatches.length" @click="nextMatch">↓</button>
        </div>
        <div class="spacer" />
        <el-button v-if="editMode !== 'skill' && editMode !== 'combo'" size="small" @click="triggerImport">导入</el-button>
        <el-button v-if="editMode !== 'skill' && editMode !== 'combo'" size="small" @click="exportDoc">导出{{ editMode === 'semantic' ? ' JSON' : ' XML' }}</el-button>
        <el-button size="small" @click="resetEdit" :disabled="!hasEdits">重置</el-button>
        <el-button type="success" size="small" :loading="applying" :disabled="!hasEdits" @click="onApply">
          应用修改
        </el-button>
      </div>
      <input
        ref="importInput"
        type="file"
        accept=".json,.xml,application/json,application/xml,text/xml"
        style="display: none"
        @change="onImportFile"
      />
      <div v-if="editMode === 'skill'" class="editor-container">
        <KfbSemanticSkillEditor :sem="semObj" @change="onSkillChange" />
      </div>
      <div v-else-if="editMode === 'combo'" class="editor-container">
        <KfbComboChainEditor :sem="semObj" @change="onSkillChange" />
      </div>
      <div v-else class="editor-container">
        <VueMonacoEditor
          :value="currentText"
          :language="editMode === 'semantic' ? 'json' : 'xml'"
          :theme="editorTheme"
          :options="editorOptions"
          class="monaco-wrap"
          @mount="onMount"
          @update:value="onEdit"
        />
      </div>
      <div class="apply-hint">
        技能/连招模式：可视化修改技能 CD / 能量 / 范围，以及动作衔接（接招段号、跳转目标帧）。JSON / XML 模式可深层编辑回写（回转验证字段无损）。应用修改后到顶部菜单「导出加密 AssetBundle」下载。
      </div>
      <el-drawer v-model="refsDrawerOpen" title="跨文件引用关系" direction="rtl" size="420px">
        <div v-if="!kfbRefs.length" class="refs-empty">未检测到跨文件引用</div>
        <div v-else class="refs-list">
          <div v-for="g in refGroups" :key="g.kind" class="ref-group">
            <div class="ref-group-title">{{ g.label }}</div>
            <div v-for="(r, i) in g.items" :key="i" class="ref-item" :class="{ broken: isRefBroken(r.target) }">
              <span class="ref-target" :title="r.sourcePath.join(' > ')">{{ r.target }}</span>
              <span class="ref-source">{{ r.sourcePath.slice(-2).join(' / ') }}</span>
              <span v-if="isRefBroken(r.target)" class="ref-status broken">✗ 不存在</span>
              <el-button v-else size="small" link type="primary" @click="onRefJump(r.target)">
                跳转<el-icon class="el-icon--right"><ArrowRight /></el-icon>
              </el-button>
            </div>
          </div>
        </div>
      </el-drawer>

      <el-drawer v-model="syncDrawerOpen" title="双 ActorData 同步" direction="rtl" size="500px">
        <div v-if="!hasActorPair" class="refs-empty">未检测到配对 ActorData（本体 ↔ P 变体）</div>
        <template v-else>
          <div class="sync-header">
            <div class="sync-dir">
              <div class="sync-label">数据源（本体）</div>
              <div class="sync-name src">{{ syncBaseName }}</div>
            </div>
            <el-icon class="sync-arrow" :size="20"><ArrowRight /></el-icon>
            <div class="sync-dir">
              <div class="sync-label">目标（变体）</div>
              <div class="sync-name dst">{{ syncVariantName }}</div>
            </div>
          </div>
          <div v-if="curIsVariant" class="sync-note">
            从变体打开：仍按<span class="force">本体 → 变体</span>方向同步，避免覆盖本体改动。
          </div>
          <div v-if="pairLoading" class="refs-empty">加载配对文件…</div>
          <div v-else>
            <div v-if="pairMsg" class="sync-msg">{{ pairMsg }}</div>
            <div v-if="pairDiffs.length" class="sync-list">
              <div class="sync-select-all">
                <el-checkbox
                  :model-value="pairAllSelected"
                  :indeterminate="pairPartialSelected"
                  @change="(v:any)=>toggleAllPairDiff(!!v)"
                >全选</el-checkbox>
                <span class="sync-count">({{ pairSelected.size }}/{{ pairLeafCount }} 可同步)</span>
              </div>
              <div
                v-for="(d, i) in pairDiffs"
                :key="i"
                class="sync-item"
                :class="{ 'not-leaf': !d.leaf }"
              >
                <el-checkbox
                  :model-value="isPairDiffSelected(i)"
                  :disabled="!d.leaf"
                  @change="(v:any)=>togglePairDiff(i, !!v)"
                />
                <div class="sync-body">
                  <div class="sync-path" :title="pairPathLabel(d)">{{ pairPathLabel(d) }}</div>
                  <div class="sync-vals">
                    <span class="a">{{ syncBaseName }}: <code>{{ d.aLabel }}</code></span>
                    <span class="b">{{ syncVariantName }}: <code>{{ d.bLabel }}</code></span>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="pairDiffs.length" class="sync-actions">
              <el-button type="primary" :loading="pairApplying" @click="applySync">
                应用勾选：{{ syncBaseName }} → {{ syncVariantName }}
              </el-button>
            </div>
          </div>
        </template>
      </el-drawer>

      <el-drawer v-model="chainDrawerOpen" title="技能链可视化" direction="rtl" size="440px">
        <div v-if="chainLoading" class="refs-empty">展开技能链…</div>
        <div v-else>
          <div v-if="chainMsg" class="sync-msg">{{ chainMsg }}</div>
          <div v-if="chainRoot" class="chain-tree">
            <ChainTreeNode
              :node="chainRoot"
              :depth="0"
              @expand="onExpandChain"
              @jump="onChainJump"
            />
          </div>
        </div>
      </el-drawer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, shallowRef, watch, onMounted, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Lock, Share, ArrowRight, CopyDocument, Connection } from '@element-plus/icons-vue';
import '@/setup/monacoEditor';
import { VueMonacoEditor } from '@guolao/vue-monaco-editor';
import type { editor } from 'monaco-editor';
import { useAssetManager } from '@/store/assetManager';
import { useDarkMode } from '@/composables/useDarkMode';
import KfbSemanticSkillEditor from '@/components/KfbSemanticSkillEditor.vue';
import KfbComboChainEditor from '@/components/KfbComboChainEditor.vue';
import KfbChainTreeNode from '@/components/KfbChainTreeNode.vue';
import { extractKfbRefs, validateRefs, findChainNode, type KfbReference, type ChainNode } from '@/workers/assetManager/kfb/kfbRefs';
import {
  findActorPair,
  isActorVariantName,
  diffObjects,
  setByPath,
  getByPath,
  type FieldDiff,
} from '@/workers/assetManager/kfb/kfbSync';

const store = useAssetManager();
const { isDark } = useDarkMode();

const info = computed(() => store.curAssetInfo);
// key 不持久化、不预填：始终留空 = 触发内置 key 库自动匹配（263 个角色）。
// 组件按资产 remount（AssetPreview 的 :key），切换文件时自动回到空输入。
const keyText = ref('');
const decoding = ref(false);
const applying = ref(false);
const decoded = ref(false);
const editMode = ref<'skill' | 'combo' | 'semantic' | 'xml'>('semantic');
const originalSemantic = ref('');
const semanticText = ref('');
const originalXml = ref('');
const xmlText = ref('');
// 技能模式：解析后的对象（含指向数据内部的引用，编辑直接改它）
const semObj = ref<any>(null);
const skillDirty = ref(false);
const jsonValid = ref<boolean | null>(null);
const jsonError = ref('');

// ── 同包 KFB TextAsset 切换 ──
const switchName = ref('');
const siblingKfbs = computed(() => {
  if (!info.value) return [];
  return store.assetInfos
    .filter((a) => a.fileId === info.value!.fileId && (a.preview as any).kfbContainer)
    .sort((a, b) => a.name.localeCompare(b.name));
});
// 所有已加载 bundle 的 KFB 资产（含 fileId），供跨 bundle 跳转
const allKfbAssets = computed(() =>
  store.assetInfos
    .filter((a) => (a.preview as any).kfbContainer)
    .sort((a, b) => a.name.localeCompare(b.name)),
);
watch(
  () => info.value?.name,
  (name) => { if (name) switchName.value = name; },
  { immediate: true },
);

// ── 跨文件引用感知 ──
const refsDrawerOpen = ref(false);
const kfbRefs = ref<KfbReference[]>([]);
const refBrokenTargets = ref<string[]>([]);
// 校验范围：所有已加载 bundle 的 KFB TextAsset 名。
// 游戏里角色本体(90059) 引用的技能包(90059xxx) 分布在其他 bundle(如 2768148785)，
// 若只查当前 bundle 会把跨 bundle 的正常引用误判为"不存在"。
const allKfbNames = computed(() =>
  store.assetInfos
    .filter((a) => (a.preview as any).kfbContainer)
    .map((a) => a.name),
);
const refGroups = computed(() => {
  const groups: { label: string; kind: KfbReference['kind']; items: KfbReference[] }[] = [];
  const interact = kfbRefs.value.filter((r) => r.kind === 'interact');
  const jump = kfbRefs.value.filter((r) => r.kind === 'jump');
  const global = kfbRefs.value.filter((r) => r.kind === 'global');
  if (interact.length) groups.push({ label: `召唤技能包 (10001)`, kind: 'interact', items: interact });
  if (jump.length) groups.push({ label: `跨包脚本切换 (1044)`, kind: 'jump', items: jump });
  if (global.length) groups.push({ label: `全局帧引用 (1031)`, kind: 'global', items: global });
  return groups;
});

// ── 双 ActorData 同步 ──
// 强制方向：本体(90059) → 变体(90059_p)。
// 无论用户从本体还是从变体打开同步抽屉，数据源都是本体，目标都是变体。
// 这样避免"从 P 变体打开把本体覆盖回去"的危险操作。
const pairName = computed(() =>
  info.value ? findActorPair(info.value.name) : undefined,
);
const pairAsset = computed(() =>
  pairName.value
    ? allKfbAssets.value.find((a) => a.name === pairName.value)
    : undefined,
);
const hasActorPair = computed(() => !!pairAsset.value);
// 当前文件名 → 是否为变体打开 → 决定方向
const curIsVariant = computed(() =>
  !!info.value && isActorVariantName(info.value.name),
);
const syncBaseName = computed(() =>
  curIsVariant.value ? pairName.value : info.value?.name, // 本体名（数据源）
);
const syncVariantName = computed(() =>
  curIsVariant.value ? info.value?.name : pairName.value, // 变体名（目标）
);
// 若从变体打开：数据源=pairAsset（本体），目标=当前文件。若从本体打开：数据源=当前文件，目标=pairAsset。
const syncSourceAsset = computed(() =>
  curIsVariant.value ? pairAsset.value : info.value,
);
const syncTargetAsset = computed(() =>
  curIsVariant.value ? info.value : pairAsset.value,
);

const syncDrawerOpen = ref(false);
const pairLoading = ref(false);
const pairSemantic = ref<any>(null); // 目标（变体）的 semantic（将被修改后写回）
const pairSourceSemantic = ref<any>(null); // 源（本体）的 semantic（只读，做数据源）
const pairDiffs = ref<FieldDiff[]>([]);
const pairSelected = ref<Set<number>>(new Set());
const pairApplying = ref(false);
const pairMsg = ref('');

async function openSyncDrawer() {
  syncDrawerOpen.value = true;
  await loadPairDiff();
}

async function loadPairDiff() {
  if (!syncSourceAsset.value || !syncTargetAsset.value) return;
  pairLoading.value = true;
  pairMsg.value = '';
  try {
    const [srcRes, dstRes] = await Promise.all([
      store.kfbDecodeAsset(
        syncSourceAsset.value.fileId,
        syncSourceAsset.value.pathId,
        keyText.value.trim(),
      ),
      store.kfbDecodeAsset(
        syncTargetAsset.value.fileId,
        syncTargetAsset.value.pathId,
        keyText.value.trim(),
      ),
    ]);
    // 方向统一：源 semantic 做 A，目标 semantic 做 B。
    // diffObjects(a=源, b=目标) 显示"源的值 → 目标的值"，同步时"源的值写入目标对应路径"。
    pairSourceSemantic.value = JSON.parse(srcRes.semantic);
    pairSemantic.value = JSON.parse(dstRes.semantic);
    pairDiffs.value = diffObjects(pairSourceSemantic.value, pairSemantic.value);
    // 默认全选可同步的叶子差异
    pairSelected.value = new Set(
      pairDiffs.value.map((_, i) => i).filter((i) => pairDiffs.value[i].leaf),
    );
    if (!pairDiffs.value.length) pairMsg.value = `本体(${syncBaseName.value}) 与变体(${syncVariantName.value}) 完全一致，无需同步`;
  } catch (e) {
    pairMsg.value = `加载配对文件失败：${e}`;
  } finally {
    pairLoading.value = false;
  }
}

function pairPathLabel(d: FieldDiff): string {
  return d.path.join(' › ');
}

function isPairDiffSelected(i: number): boolean {
  return pairSelected.value.has(i);
}

const pairLeafCount = computed(() => pairDiffs.value.filter((d) => d.leaf).length);
const pairAllSelected = computed(
  () => pairLeafCount.value > 0 && pairSelected.value.size === pairLeafCount.value,
);
const pairPartialSelected = computed(
  () => pairSelected.value.size > 0 && pairSelected.value.size < pairLeafCount.value,
);

function togglePairDiff(i: number, on: boolean) {
  const next = new Set(pairSelected.value);
  if (on) next.add(i);
  else next.delete(i);
  pairSelected.value = next;
}

function toggleAllPairDiff(on: boolean) {
  if (on) {
    pairSelected.value = new Set(
      pairDiffs.value.map((_, i) => i).filter((i) => pairDiffs.value[i].leaf),
    );
  } else {
    pairSelected.value = new Set();
  }
}

async function applySync() {
  if (!syncTargetAsset.value || !pairSemantic.value || !pairSourceSemantic.value) return;
  // 反向方向（变体→本体）强制确认：正常流程下 syncSource 永远是本体，
  // 该分支保留用于未来扩展或防呆兜底。
  if (isActorVariantName(syncSourceAsset.value?.name ?? '')) {
    try {
      await ElMessageBox.confirm(
        `即将把变体 ${syncSourceAsset.value?.name ?? ''} 的值覆盖到本体 ${syncTargetAsset.value.name}。\n这是高风险操作，可能丢失本体特有的字段！\n是否确认继续？`,
        '危险操作确认',
        { type: 'error', confirmButtonText: '仍然执行', cancelButtonText: '取消' },
      );
    } catch {
      pairMsg.value = '已取消（变体→本体的风险操作被阻止）';
      return;
    }
  }
  pairApplying.value = true;
  try {
    const selected = pairDiffs.value.filter((_, i) => pairSelected.value.has(i));
    if (!selected.length) {
      pairMsg.value = '未选择任何差异';
      return;
    }
    // 数据源：本体（pairSourceSemantic）；目标：变体 pairSemantic
    let applied = 0;
    for (const d of selected) {
      const val = getByPath(pairSourceSemantic.value, d.path);
      if (setByPath(pairSemantic.value, d.path, val)) applied++;
    }
    const text = JSON.stringify(pairSemantic.value, null, 2);
    const ok = await store.kfbApplyToAsset(
      syncTargetAsset.value.fileId,
      syncTargetAsset.value.pathId,
      keyText.value.trim(),
      text,
      'semantic',
    );
    pairMsg.value = ok
      ? `已同步 ${applied}/${selected.length} 处：${syncBaseName.value} → ${syncVariantName.value}`
      : '同步失败（写回返回 false）';
  } catch (e) {
    pairMsg.value = `同步失败：${e}`;
  } finally {
    pairApplying.value = false;
  }
}

// ── 技能链可视化 ──
// 从当前文件出发，沿 interact 引用递归展开"召唤链"，懒加载（点开才解密下一层）。
const chainDrawerOpen = ref(false);
const chainRoot = ref<ChainNode | null>(null);
const chainLoading = ref(false);
const chainMsg = ref('');

async function openChainDrawer() {
  chainDrawerOpen.value = true;
  chainLoading.value = true;
  chainMsg.value = '';
  try {
    const rootName = info.value?.name ?? '';
    chainRoot.value = {
      name: rootName,
      exists: !!info.value,
      children: [],
      loaded: false,
    };
    await expandChainNode(chainRoot.value);
  } catch (e) {
    chainMsg.value = `展开技能链失败：${e}`;
  } finally {
    chainLoading.value = false;
  }
}

/** 懒展开一个链节点：解密该资产，取其 interact 引用作为下一层 */
async function expandChainNode(node: ChainNode) {
  if (node.loaded) return;
  const asset = allKfbAssets.value.find((a) => a.name === node.name);
  if (!asset) {
    node.loaded = true;
    return;
  }
  node.loaded = true;
  try {
    const res = await store.kfbDecodeAsset(asset.fileId, asset.pathId, keyText.value.trim());
    const refs = extractKfbRefs(JSON.parse(res.semantic));
    const targets = refs.filter((r) => r.kind === 'interact');
    const root = chainRoot.value;
    node.children = targets.map((r) => {
      const child = {
        name: r.target,
        exists: allKfbNames.value.includes(r.target),
        children: [],
        loaded: false,
      };
      // 防环：目标已在链上（root 存在时）则标记 loaded，避免无限展开。
      // 用 name 匹配（同层不重名），root 为 null 时跳过（外部误用不崩溃）。
      if (root && findChainNode(root, child.name)) child.loaded = true;
      return child;
    });
  } catch {
    // 解密失败视为无子节点
    node.children = [];
  }
}

async function onExpandChain(node: ChainNode) {
  if (node.children.length) return;
  await expandChainNode(node);
}

function onChainJump(name: string) {
  chainDrawerOpen.value = false;
  onSwitchKfb(name);
}

// 编辑器实例与搜索状态
const editorRef = shallowRef<editor.IStandaloneCodeEditor | null>(null);
const monacoRef = shallowRef<any>(null);
const searchText = ref('');
const searchOpen = ref(false);
const searchMatches = ref<{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }[]>([]);
const searchIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
let decoIds: string[] = [];

const hasEdits = computed(() => {
  if (!decoded.value) return false;
  if (editMode.value === 'skill' || editMode.value === 'combo') return skillDirty.value;
  return editMode.value === 'semantic'
    ? semanticText.value !== originalSemantic.value
    : xmlText.value !== originalXml.value;
});

const currentText = computed(() => (editMode.value === 'semantic' ? semanticText.value : xmlText.value));

// 进入/退出技能/连招模式：进入解析语义对象，退出若有改动则回写 semanticText
watch(editMode, (mode, prev) => {
  if (mode === 'skill' || mode === 'combo') {
    semObj.value = JSON.parse(semanticText.value);
    skillDirty.value = false;
  } else if ((prev === 'skill' || prev === 'combo') && skillDirty.value) {
    semanticText.value = JSON.stringify(semObj.value, null, 2);
  }
  clearSearch();
});

function onSkillChange() {
  skillDirty.value = true;
}

function onEdit(v: string) {
  if (editMode.value === 'semantic') semanticText.value = v;
  else xmlText.value = v;
  jsonValid.value = null;
  clearSearch();
}

// ── 关键词搜索（基于 Monaco model.findMatches，可控高亮 + 上下跳转）──
function onMount(ed: editor.IStandaloneCodeEditor, monaco: any) {
  editorRef.value = ed;
  monacoRef.value = monaco;
  if (searchText.value.trim()) runSearch();
}

function clearSearch() {
  searchMatches.value = [];
  searchIndex.value = 0;
  if (editorRef.value) decoIds = editorRef.value.deltaDecorations(decoIds, []);
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value;
  if (searchOpen.value) {
    // 打开时若已有内容则立即搜一次，并聚焦输入框
    requestAnimationFrame(() => searchInput.value?.focus());
    if (searchText.value.trim()) runSearch();
  } else {
    clearSearch();
  }
}

function runSearch() {
  const ed = editorRef.value;
  const monaco = monacoRef.value;
  if (!ed || !monaco) return;
  const model = ed.getModel();
  if (!model) return;
  const term = searchText.value.trim();
  if (!term) {
    clearSearch();
    return;
  }
  const matches = model.findMatches(term, false, false, true, null, false);
  searchMatches.value = matches.map((m) => m.range);
  searchIndex.value = matches.length ? 1 : 0;
  applyDeco();
  if (matches.length) revealCurrent();
}

function applyDeco() {
  const ed = editorRef.value;
  const monaco = monacoRef.value;
  if (!ed || !monaco) return;
  const decos = searchMatches.value.map((r, i) => ({
    range: new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn),
    options: {
      inlineClassName: i === searchIndex.value - 1 ? 'kfb-search-hit kfb-search-current' : 'kfb-search-hit',
    },
  }));
  decoIds = ed.deltaDecorations(decoIds, decos);
}

function revealCurrent() {
  const ed = editorRef.value;
  if (!ed || !searchMatches.value.length) return;
  const r = searchMatches.value[searchIndex.value - 1];
  ed.revealRangeInCenter(r);
  ed.setSelection(r);
}

function nextMatch() {
  if (!searchMatches.value.length) return;
  searchIndex.value = searchIndex.value >= searchMatches.value.length ? 1 : searchIndex.value + 1;
  applyDeco();
  revealCurrent();
}

function prevMatch() {
  if (!searchMatches.value.length) return;
  searchIndex.value = searchIndex.value <= 1 ? searchMatches.value.length : searchIndex.value - 1;
  applyDeco();
  revealCurrent();
}

// ── 导入 JSON / XML ──
function triggerImport() {
  importInput.value?.click();
}

function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result ?? '');
    const isJson = file.name.toLowerCase().endsWith('.json') || /^\s*[[{]/.test(text);
    if (isJson) {
      editMode.value = 'semantic';
      semanticText.value = text;
    } else {
      editMode.value = 'xml';
      xmlText.value = text;
    }
    jsonValid.value = null;
    clearSearch();
    ElMessage({ message: `已导入 ${file.name}（${isJson ? 'JSON' : 'XML'}）`, type: 'success' });
  };
  reader.readAsText(file);
  input.value = '';
}

// 切换语义/XML 模式时清空搜索（装饰可能错位）
// （清空逻辑已并入上面的 editMode watcher）

const editorTheme = computed(() => (isDark.value ? 'vs-dark' : 'vs'));
const editorOptions = computed<editor.IStandaloneEditorConstructionOptions>(() => ({
  wordWrap: 'off',
  automaticLayout: true,
  scrollBeyondLastLine: false,
  tabSize: 2,
  fontSize: 13,
  fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
  lineNumbers: 'on',
  renderLineHighlight: 'all',
  renderWhitespace: 'selection',
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  padding: { top: 8, bottom: 8 },
  // 大文件优化：关闭语法验证等重计算，编辑更跟手
  minimap: { enabled: false },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  matchBrackets: 'never',
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  unicodeHighlight: {
    ambiguousCharacters: false,
    includeComments: false,
    includeStrings: false,
    invisibleCharacters: false,
    nonBasicASCII: false,
  },
}));

async function onDecode(silent = false) {
  if (!info.value) return;
  decoding.value = true;
  try {
    const result = await store.kfbDecodeAsset(info.value.fileId, info.value.pathId, keyText.value.trim());
    semanticText.value = result.semantic;
    originalSemantic.value = result.semantic;
    xmlText.value = result.xml;
    originalXml.value = result.xml;
    decoded.value = true;
    editMode.value = 'semantic';
    jsonValid.value = null;
    // 解密成功后提取跨文件引用
    refreshRefs();
    // 自动匹配时回填命中的 key，方便回写
    if (result.usedKey && !keyText.value.trim()) {
      keyText.value = result.usedKey;
    }
    if (!silent) {
      ElMessage({
        message: result.usedKey ? `解密成功（key ${result.usedKey.slice(0, 12)}…）` : `解密成功（${info.value.name}）`,
        type: 'success',
      });
    }
  } catch (e) {
    // 自动匹配失败：保持锁定界面，让用户看到可手动填 key 的输入框
    ElMessage({ message: `解密失败：${e}`, type: 'error' });
  } finally {
    decoding.value = false;
  }
}

// 打开 KFB 编辑器即自动解密（key 留空会走内置 key 库自动匹配）。
// 若匹配失败，停留在锁定界面，用户可手动输入 key 后重试。
onMounted(() => {
  if (info.value) onDecode(true);
});

function formatDoc() {
  if (editMode.value === 'semantic') {
    try {
      semanticText.value = JSON.stringify(JSON.parse(semanticText.value), null, 2);
      jsonValid.value = true;
      jsonError.value = '';
    } catch (e) {
      jsonValid.value = false;
      jsonError.value = `${e}`;
    }
  } else {
    // XML 格式化：简单缩进美化（避免引入复杂 XML 解析依赖）
    const lines = xmlText.value.split(/>\s*</);
    if (lines.length > 1) {
      let depth = 0;
      const out = lines.map((line, i) => {
        let trimmed = line.trim();
        if (i > 0) trimmed = `<${trimmed}`;
        if (i < lines.length - 1) trimmed = `${trimmed}>`;
        if (trimmed.startsWith('</')) depth = Math.max(0, depth - 1);
        const indent = '  '.repeat(depth);
        if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.endsWith('/>') && !trimmed.startsWith('<?')) depth++;
        return `${indent}${trimmed}`;
      });
      xmlText.value = out.join('\n');
    }
    jsonValid.value = true;
    jsonError.value = '';
  }
}

function validateDoc() {
  if (editMode.value === 'semantic') {
    try {
      JSON.parse(semanticText.value);
      jsonValid.value = true;
      jsonError.value = '';
    } catch (e) {
      jsonValid.value = false;
      jsonError.value = `${e}`;
    }
  } else {
    // XML 校验：粗校验（根元素闭合）
    const t = xmlText.value.trim();
    const ok = t.startsWith('<') && t.includes('</');
    jsonValid.value = ok;
    jsonError.value = ok ? '' : 'XML 缺少闭合标签';
  }
}

function resetEdit() {
  if (editMode.value === 'skill' || editMode.value === 'combo') {
    semObj.value = JSON.parse(originalSemantic.value);
    skillDirty.value = false;
  } else if (editMode.value === 'semantic') {
    semanticText.value = originalSemantic.value;
  } else {
    xmlText.value = originalXml.value;
  }
  jsonValid.value = null;
}

/** 导出当前编辑的 JSON / XML（按模式） */
function exportDoc() {
  const text = currentText.value;
  if (!text) {
    ElMessage({ message: '没有可导出的内容', type: 'warning' });
    return;
  }
  const isJson = editMode.value === 'semantic';
  const blob = new Blob([text], { type: isJson ? 'application/json' : 'text/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${info.value?.name ?? 'kfb_data'}${isJson ? '.json' : '.xml'}`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage({ message: `已导出 ${a.download}（${(text.length / 1024).toFixed(0)}KB）`, type: 'success' });
}

// ── 同包 KFB 切换（引用跳转支持跨 bundle）──
async function onSwitchKfb(name: string) {
  // 优先当前 bundle，其次其他已加载 bundle（跨 bundle 跳转）
  const target =
    siblingKfbs.value.find((s) => s.name === name) ??
    allKfbAssets.value.find((s) => s.name === name);
  if (!target || (target.pathId === info.value?.pathId && target.fileId === info.value?.fileId)) return;
  // 有未保存修改时确认
  if (hasEdits.value) {
    try {
      await ElMessageBox.confirm(
        `当前 ${info.value?.name} 有未应用修改，切换将丢失。是否继续？`,
        '切换确认',
        { type: 'warning', confirmButtonText: '切换', cancelButtonText: '取消' },
      );
    } catch {
      // 用户取消，恢复选中名
      switchName.value = info.value?.name ?? '';
      return;
    }
  }
  store.setCurAssetInfo(target);
  decoded.value = false;
  keyText.value = '';
  kfbRefs.value = [];
  refBrokenTargets.value = [];
  await nextTick();
  onDecode(true);
}

// ── 跨文件引用感知 ──
function refreshRefs() {
  try {
    const sem = JSON.parse(semanticText.value);
    kfbRefs.value = extractKfbRefs(sem);
    const { broken } = validateRefs(kfbRefs.value, allKfbNames.value);
    refBrokenTargets.value = [...new Set(broken.map((b) => b.target))];
  } catch {
    kfbRefs.value = [];
    refBrokenTargets.value = [];
  }
}

function openRefsDrawer() {
  refreshRefs();
  refsDrawerOpen.value = true;
}

function isRefBroken(target: string): boolean {
  return refBrokenTargets.value.includes(target);
}

function onRefJump(target: string) {
  if (isRefBroken(target)) return;
  refsDrawerOpen.value = false;
  onSwitchKfb(target);
}

async function onApply() {
  if (!info.value) return;
  applying.value = true;
  try {
    let text: string;
    let format: 'semantic' | 'xml';
    if (editMode.value === 'skill' || editMode.value === 'combo') {
      // 可视化模式：把语义对象序列化回 semantic JSON，再按 semantic 格式应用
      text = JSON.stringify(semObj.value, null, 2);
      format = 'semantic';
    } else {
      format = editMode.value;
      text = currentText.value;
      if (format === 'semantic') {
        try {
          JSON.parse(text);
        } catch (e) {
          ElMessage({ message: `JSON 不合法，无法应用：${e}`, type: 'error' });
          return;
        }
      }
    }
    // 应用前校验跨文件引用：破坏性引用拦截
    if (format === 'semantic') {
      const refs = extractKfbRefs(JSON.parse(text));
      const { broken } = validateRefs(refs, allKfbNames.value);
      if (broken.length) {
        const targets = [...new Set(broken.map((b) => b.target))];
        try {
          await ElMessageBox.confirm(
            `以下引用目标在所有已加载文件中未找到，应用后可能导致技能失效：\n${targets.join('\n')}\n\n仍要应用吗？`,
            '引用校验警告',
            { type: 'warning', confirmButtonText: '仍然应用', cancelButtonText: '取消' },
          );
        } catch {
          return; // 用户取消
        }
      }
    }
    await store.kfbApplyToAsset(info.value.fileId, info.value.pathId, keyText.value.trim(), text, format);
    if (format === 'semantic') {
      semanticText.value = text;
      originalSemantic.value = text;
      if (editMode.value === 'skill' || editMode.value === 'combo') skillDirty.value = false;
      refreshRefs();
    } else {
      originalXml.value = text;
    }
  } finally {
    applying.value = false;
  }
}
</script>

<style lang="scss" scoped>
.kfb-asset-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  gap: 8px;
}

.kfb-lock {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 20px;

  .lock-icon {
    font-size: 42px;
    color: var(--el-color-warning);
  }

  .lock-title {
    font-size: 15px;
    font-weight: 600;
    color: #e6e8ee;
  }

  .lock-desc {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.55);
    max-width: 520px;
    line-height: 1.7;
  }

  .key-row {
    display: flex;
    gap: 8px;
    width: min(560px, 90%);

    .key-input {
      flex: 1;
    }
  }

  .lock-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
  }
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;

  .asset-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--el-color-primary);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sibling-select {
    width: 200px;
  }

  .ref-badge {
    display: inline-block;
    min-width: 18px;
    height: 18px;
    line-height: 18px;
    text-align: center;
    border-radius: 9px;
    background: var(--el-color-primary-light-7);
    color: var(--el-color-primary);
    font-size: 11px;
    font-weight: 600;
    padding: 0 5px;
    margin-left: 2px;
  }

  .spacer {
    flex: 1;
  }

  .ok-hint {
    color: #67c23a;
    font-size: 12px;
  }

  .err-hint {
    color: #f56c6c;
    font-size: 12px;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.editor-container {
  flex: 1;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  overflow: hidden;

  .monaco-wrap {
    width: 100%;
    height: 100%;
  }
}

.apply-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
}

.search-wrap {
  display: flex;
  align-items: center;
  gap: 4px;

  .search-input {
    width: 140px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--el-border-color);
    border-radius: 4px;
    background: var(--el-fill-color-blank);
    color: var(--el-text-color-primary);
    font-size: 12px;
    outline: none;

    &:focus {
      border-color: var(--el-color-primary);
    }
  }

  .search-count {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    min-width: 34px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .search-nav {
    width: 22px;
    height: 22px;
    border: 1px solid var(--el-border-color);
    border-radius: 4px;
    background: var(--el-fill-color-blank);
    color: var(--el-text-color-primary);
    cursor: pointer;
    font-size: 12px;
    line-height: 1;

    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    &:not(:disabled):hover {
      border-color: var(--el-color-primary);
      color: var(--el-color-primary);
    }
  }
}

:deep(.kfb-search-hit) {
  background: rgba(255, 214, 0, 0.28);
  border-radius: 2px;
}

:deep(.kfb-search-current) {
  background: rgba(255, 153, 0, 0.55);
  outline: 1px solid rgba(255, 153, 0, 0.9);
}

.refs-empty {
  color: rgba(255, 255, 255, 0.4);
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}

.refs-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ref-group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.ref-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;

  .ref-target {
    font-weight: 600;
    color: var(--el-text-color-primary);
    min-width: 120px;
  }

  .ref-source {
    flex: 1;
    color: rgba(255, 255, 255, 0.35);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ref-status.broken {
    color: #f56c6c;
    font-weight: 600;
  }

  &.broken .ref-target {
    color: #f56c6c;
  }
}

.sync-header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  margin-bottom: 10px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;

  .sync-dir {
    flex: 1;
    min-width: 0;
    text-align: center;
  }
  .sync-label {
    font-size: 11px;
    color: var(--el-text-color-secondary);
    margin-bottom: 3px;
  }
  .sync-name {
    font-weight: 700;
    font-size: 14px;
    word-break: break-all;
    &.src { color: var(--el-color-success); }
    &.dst { color: var(--el-color-warning); }
  }
  .sync-arrow {
    color: var(--el-text-color-secondary);
    flex-shrink: 0;
  }
}

.sync-note {
  font-size: 12px;
  color: var(--el-color-info);
  margin-bottom: 10px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 3px solid var(--el-color-info);
  border-radius: 0 4px 4px 0;

  .force {
    color: var(--el-color-primary);
    font-weight: 600;
  }
}

.sync-msg {
  font-size: 12px;
  color: var(--el-color-primary);
  padding: 8px 0;
}

.sync-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sync-select-all {
  font-size: 12px;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  display: flex;
  align-items: center;
  gap: 8px;

  .sync-count {
    color: var(--el-text-color-secondary);
  }
}

.sync-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--el-border-color-lighter);

  &.not-leaf {
    opacity: 0.5;
  }

  .sync-body {
    flex: 1;
    min-width: 0;
  }

  .sync-path {
    font-size: 12px;
    font-weight: 600;
    color: var(--el-text-color-primary);
    word-break: break-all;
  }

  .sync-vals {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 3px;
    font-size: 11px;

    .a {
      color: var(--el-color-success);
    }
    .b {
      color: var(--el-color-warning);
    }
    code {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      padding: 0 4px;
    }
  }
}

.sync-actions {
  margin-top: 14px;
  text-align: right;
}

.chain-tree {
  display: flex;
  flex-direction: column;
}
</style>
