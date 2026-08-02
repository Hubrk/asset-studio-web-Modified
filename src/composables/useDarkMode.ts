import { ref, watch } from 'vue';

const isDark = ref(false);

const LS_KEY = 'darkMode';

function applyDark(dark: boolean) {
  if (dark) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  localStorage.setItem(LS_KEY, String(dark));
}

function loadDarkMode() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved === 'true') {
    isDark.value = true;
    applyDark(true);
  } else {
    isDark.value = false;
    applyDark(false);
  }
}

watch(isDark, (val) => {
  applyDark(val);
});

export function useDarkMode() {
  return {
    isDark,
    toggle: () => { isDark.value = !isDark.value; },
    load: loadDarkMode,
  };
}
