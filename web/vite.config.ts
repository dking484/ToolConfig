import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// During development, proxy Moonraker on the printer so the app runs
// same-origin exactly like it does when nginx serves it at /toolconfig/.
const printer = process.env.PRINTER_URL ?? 'http://voron.local'

export default defineConfig({
  base: '/toolconfig/',
  plugins: [vue()],
  server: {
    port: 5180,
    proxy: {
      '/websocket': { target: printer.replace(/^http/, 'ws'), ws: true },
      '/server': printer,
      '/printer': printer,
      '/machine': printer,
      '/access': printer,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
