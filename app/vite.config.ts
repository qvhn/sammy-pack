import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sammyPackApiPlugin } from './sammy-pack-api';

export default defineConfig({
  plugins: [react(), sammyPackApiPlugin()],
  root: path.resolve(__dirname, 'web'),
  publicDir: false,
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.tsx',
      '.ts',
      '.jsx',
      '.js',
      '.json',
    ],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    global: 'globalThis',
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development'),
  },
  optimizeDeps: {
    esbuildOptions: {
      resolveExtensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js'],
      loader: { '.js': 'jsx' },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'web-dist'),
    emptyOutDir: true,
    rollupOptions: {
      // Server-only code is co-located in src/ (the executor, the API plugin's
      // runtime) and reaches Node-only deps — notably @anthropic-ai/claude-agent-sdk,
      // whose `#!/usr/bin/env node` shebang the production rollup parser rejects, and
      // the node: builtins. Those are never executed in the browser (they sit behind
      // the server middleware / SSR boundary), so externalize them from the CLIENT
      // bundle: rollup leaves the imports untouched instead of trying to parse/bundle
      // a Node package. (The proper long-term fix is a hard client/server import split;
      // this unblocks `vite build` without that refactor.)
      external: [/^node:/, '@anthropic-ai/claude-agent-sdk'],
    },
  },
  server: {
    port: 5173,
  },
});
