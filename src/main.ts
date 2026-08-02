import './setup/serviceWorker';
import './setup/vxeTableStyle';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './main.scss';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import en from 'element-plus/es/locale/lang/en';
import App from './App.vue';
import { VxeTableModules } from './setup/vxeTable';
import { loadLocale } from '@/composables/useLocale';
import { useDarkMode } from '@/composables/useDarkMode';

loadLocale();
useDarkMode().load();

const app = createApp(App);

app.use(createPinia());
app.use(ElementPlus, { locale: zhCn });
app.use(VxeTableModules);

(window as any).__ELEMENTPLUS_LOCALE__ = (locale: string) => {
  const elLocale = locale === 'zh-CN' ? zhCn : en;
  app.config.globalProperties.$ELEMENT = { locale: elLocale };
};

app.mount('#app');
