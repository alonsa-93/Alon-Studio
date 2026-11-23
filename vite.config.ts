import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // never watch data or built packages (a release build replaces thousands of files, some locked)
  server: { watch: { ignored: ['**/data/**', '**/release*/**', '**/ui-out/**', '**/dist/**'] } },
  build: { outDir: 'dist' },
});
