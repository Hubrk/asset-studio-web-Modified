<template>
  <div class="chain-node" :style="{ paddingLeft: depth * 18 + 'px' }">
    <div class="chain-row" :class="{ root: depth === 0 }">
      <button v-if="node.children.length" class="chain-toggle" @click="$emit('expand', node)">
        <span :class="{ open: expanded }">▸</span>
      </button>
      <button v-else class="chain-toggle ghost" :disabled="!node.exists" @click="onLoadChild">
        <span>▸</span>
      </button>
      <span class="chain-name" :class="{ missing: !node.exists }">{{ node.name }}</span>
      <span v-if="!node.exists" class="chain-status missing">未加载</span>
      <el-button v-if="node.exists && depth > 0" size="small" link type="primary" @click="$emit('jump', node.name)">
        跳转
      </el-button>
    </div>
    <template v-if="expanded">
      <div v-if="!node.children.length" class="chain-empty">（无召唤/未加载）</div>
      <KfbChainTreeNode
        v-for="c in node.children"
        :key="c.name"
        :node="c"
        :depth="depth + 1"
        @expand="$emit('expand', $event)"
        @jump="$emit('jump', $event)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ChainNode } from '@/workers/assetManager/kfb/kfbRefs';

const props = defineProps<{ node: ChainNode; depth: number }>();
const emit = defineEmits<{
  (e: 'expand', node: ChainNode): void;
  (e: 'jump', name: string): void;
}>();

const expanded = ref(false);
// 有子节点时默认展开根层；无子节点需手动展开（懒加载）
watch(
  () => props.node.children.length,
  (n) => {
    if (props.depth === 0 && n > 0) expanded.value = true;
  },
);

function onLoadChild() {
  if (props.node.loaded && props.node.children.length) {
    expanded.value = true;
  } else {
    emit('expand', props.node);
    expanded.value = true;
  }
}
</script>

<style scoped>
.chain-node {
  font-size: 13px;
}

.chain-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;

  &.root .chain-name {
    font-weight: 700;
    color: var(--el-color-primary);
  }
}

.chain-toggle {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;

  span {
    display: inline-block;
    transition: transform 0.15s;
    &.open {
      transform: rotate(90deg);
    }
  }

  &.ghost {
    color: var(--el-text-color-disabled);
    &:disabled {
      cursor: default;
    }
  }
}

.chain-name {
  font-weight: 600;
  &.missing {
    color: var(--el-color-danger);
  }
}

.chain-status.missing {
  color: var(--el-color-danger);
  font-size: 11px;
}

.chain-empty {
  color: var(--el-text-color-disabled);
  font-size: 11px;
  padding: 2px 0 2px 24px;
}
</style>
