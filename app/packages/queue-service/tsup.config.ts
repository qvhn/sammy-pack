import { defineConfig } from 'tsup';

/**
 * Bundle the connector runtime + CLI into a FLAT dist/.
 *
 * Two entries: the library (src/index.ts) and the standalone host
 * (src/bin/run.ts). Externals:
 *   - @sammy-pack/sdk : the contract + makeHttpDeliver (a real dependency,
 *                       resolved from the installed package at runtime).
 *   - @sammy-pack/*   : the source-* adapter packages the CLI shims load
 *                       via DYNAMIC import; never statically linked, so they
 *                       stay optional (install only the ones you reference).
 *   - node builtins   : implicit on esbuild's node platform.
 *
 * dts is on for the library so embedders get types for QueueService /
 * SourceRegistry / SourceBinding.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin/run.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  sourcemap: true,
  clean: true,
  target: 'node22',
  external: [
    '@sammy-pack/sdk',
    '@sammy-pack/source-sqs',
    '@sammy-pack/source-kafka',
    '@sammy-pack/source-rabbitmq',
  ],
});
