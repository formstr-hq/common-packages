import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Alias workspace imports straight to the signer's source so changes show up
// instantly with no rebuild step. Order matters — more specific entries first.
export default defineConfig({
  // './' for relative asset URLs in the Capacitor Android WebView;
  // 'es2022' so top-level await (used to lazy-load the Android plugin
  // only on android) survives the production build.
  base: './',
  build: {
    target: 'es2022',
  },
  resolve: {
    alias: [
      {
        find: '@formstr/signer/styles.css',
        replacement: resolve(__dirname, '../../packages/signer/styles/signer.css'),
      },
      {
        find: '@formstr/signer/ui',
        replacement: resolve(__dirname, '../../packages/signer/src/ui/index.ts'),
      },
      {
        find: '@formstr/signer',
        replacement: resolve(__dirname, '../../packages/signer/src/index.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    fs: { allow: ['../..'] },
    // Use polling to dodge `EMFILE` from low `fs.inotify.max_user_instances`
    // (Linux default is often 128 — pnpm workspaces blow through that).
    watch: {
      usePolling: true,
      interval: 1000,
      ignored: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    },
  },
});
