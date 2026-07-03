import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        // Main exam portal → /index.html
        main: resolve(__dirname, 'index.html'),
        // HR admin portal → /hr/index.html  (accessible at /hr or /hr/)
        hr: resolve(__dirname, 'hr/index.html'),
      },
    },
  },
})
