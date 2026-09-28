import { defineConfig } from 'vite';
export default defineConfig({ server: { host: '127.0.0.1' }, build: { chunkSizeWarningLimit: 1600 } });
