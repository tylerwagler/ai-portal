import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(() => {
  const apiBase = process.env.VITE_GPU_API_BASE;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // import.meta.dirname keeps this resolvable under Vite's native config
        // loader, which does not provide __dirname.
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      port: 3000,
      ...(apiBase && {
        proxy: {
          '/api': {
            target: apiBase,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
          },
        },
      }),
    },
  };
});
