import { createSSRApp } from 'vue';
import App from './App.vue';

// Uni-app Vue3 入口
export function createApp() {
  const app = createSSRApp(App);
  return { app };
}
