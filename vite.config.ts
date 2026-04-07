import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 套壳 Android 从 file:// 加载时需要相对路径
  base: './',
})
