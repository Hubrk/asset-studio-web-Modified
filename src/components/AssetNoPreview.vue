<template>
  <el-empty :description="desc ?? messages.noPreview" style="height: 100%" />
</template>

<script setup lang="ts">
import { useLocale } from '@/composables/useLocale';

const { messages } = useLocale();

const { desc } = defineProps<{
  asset: any;
  data: string | null;
  desc?: string;
}>();
</script>
