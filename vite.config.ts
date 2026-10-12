import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // three.js makes a single ~570 kB chunk; that is the whole game, not bloat.
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
})
