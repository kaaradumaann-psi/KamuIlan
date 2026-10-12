import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Arena preview host is {port}-{id}.e2b.app; '.e2b.app' suffix izinli.
 * host 0.0.0.0 konteyner dışından erişim için gerekli.
 *
 * /api istekleri sandbox içindeki Node API'sine (127.0.0.1:3000) proxy'lenir;
 * tarayıcı yalnızca göreli /api yollarını çağırır, localhost'a istek atmaz.
 */
export default defineConfig({
  appType: 'spa',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app'],
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['.e2b.app'],
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('react-router')) return 'vendor';
          if (id.includes('@tanstack')) return 'query';
          return undefined;
        },
      },
    },
  },
});
