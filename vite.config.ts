import { defineConfig, splitVendorChunkPlugin } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  // GitHub Pages uses a sub-path like `/repo/`, so use a relative base to make
  // built assets work regardless of where the site is hosted.
  base: './',
  plugins: [solid(), splitVendorChunkPlugin()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/')) return 'vendor';
          if (id.includes('/src/core/')) return 'core';
          if (id.includes('/src/decode/')) return 'decoders';
          if (id.includes('/src/subtitle/')) return 'subtitles';
          if (id.includes('/src/demux/')) return 'demux';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg'],
  },
});
