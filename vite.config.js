import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5178",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // 本机沙箱会拦截批量删除，不自动清空产物目录，避免构建被中断
    emptyOutDir: false,
  },
});
