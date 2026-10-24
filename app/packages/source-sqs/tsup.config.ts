import { defineConfig } from 'tsup';

/**
 * Bundle the SQS adapter into a FLAT dist/.
 *
 * Two entries: the library (src/index.ts) and the standalone runner
 * (src/bin/run.ts). Both are kept thin — the heavy bits are EXTERNAL and
 * resolved at runtime from this package's own dependency tree:
 *
 *   - @aws-sdk/client-sqs : this package's OWN dependency (the whole point
 *                           — the AWS SDK lives here, never in core).
 *   - @sammy-pack/sdk     : peer dependency; the public contract
 *                           (httpDeliver, QueueSource, the signer …).
 *   - node builtins       : implicit on esbuild's node platform.
 *
 * dts is on for the library so embedders get types for startSqsSource /
 * SqsSource / SqsLike.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin/run.ts'],
  format: ['esm'],
  dts: { entry: ['src/index.ts'] },
  sourcemap: true,
  clean: true,
  target: 'node22',
  external: ['@aws-sdk/client-sqs', '@sammy-pack/sdk'],
});
