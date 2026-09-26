import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In development, the portal API and Supabase are proxied so the app runs same-origin,
// exactly as it does behind the edge in production.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        '/auth/v1': env.DEV_SUPABASE_URL ?? 'http://10.20.20.10:8800',
        '/portal': env.DEV_PORTAL_API_URL ?? 'http://127.0.0.1:8200',
      },
    },
  };
});
