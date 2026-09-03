import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

// Uni-app Vue3 + Vite 构建配置
export default defineConfig({
  plugins: [uni()]
});
