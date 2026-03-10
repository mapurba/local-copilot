import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  root: '.',
  base: './', // Use relative paths for Electron
  build: {
    outDir: 'dist',
    minify: 'esbuild',
    target: 'ES2022',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
