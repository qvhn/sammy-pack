import { defineConfig } from 'tsup';

/**
 * Bundle the SDK into a FLAT dist/.
 *
 * The SDK has no runtime dependency beyond node builtins (implicit on
 * esbuild's node platform), so nothing is marked external — the whole
 * tiny surface (the queue-source contract + the client signer) bundles
 * with types.
 *
 * DUAL-FORMAT (esm + cjs): the SDK is consumed both by ESM importers
 * (adapters, the app bundle) AND by CJS `require` contexts — notably
 * vite's config bundler, which loads the API plugin -> server/webhook-auth
 * (which re-exports the signer from here). An ESM-only build there fails with
 * "This package is ESM only but it was tried to load by `require`". Emitting
 * both (with a matching exports map) keeps it loadable everywhere; with
 * package `type: module`, tsup writes index.js (esm) + index.cjs (cjs).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
});
