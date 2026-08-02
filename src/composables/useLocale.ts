import { ref, computed, watch } from 'vue';
import type { Locale, LocaleMessages } from '@/locale';
import { zhCN, enUS } from '@/locale';
import { setConfig } from 'vxe-table/es/v-x-e-table';

const locale = ref<Locale>('zh-CN');

const messages = computed<LocaleMessages>(() => {
  return locale.value === 'zh-CN' ? zhCN : enUS;
});

const updateVxeTableLocale = (newLocale: Locale) => {
  const m = newLocale === 'zh-CN' ? zhCN : enUS;
  setConfig({
    i18n: (key: string) => {
      const keyMap: Record<string, string> = {
        'vxe.table.allFilter': m.vxeTableAllFilter,
        'vxe.table.confirmFilter': m.vxeTableConfirmFilter,
        'vxe.table.resetFilter': m.vxeTableResetFilter,
        'vxe.loading.text': m.vxeLoadingText,
      };
      return keyMap[key] ?? (import.meta.env.DEV ? key : '');
    },
  });
};

const setLocale = (newLocale: Locale) => {
  locale.value = newLocale;
  localStorage.setItem('locale', newLocale);
  updateVxeTableLocale(newLocale);
  
  const elementLocale = (window as any).__ELEMENTPLUS_LOCALE__;
  if (elementLocale) {
    elementLocale(newLocale);
  }
};

const loadLocale = () => {
  const saved = localStorage.getItem('locale') as Locale | null;
  if (saved) {
    locale.value = saved;
    updateVxeTableLocale(saved);
  }
};

watch(locale, (newLocale) => {
  document.documentElement.lang = newLocale;
});

export function useLocale() {
  return {
    locale,
    messages,
    setLocale,
  };
}

export { loadLocale };