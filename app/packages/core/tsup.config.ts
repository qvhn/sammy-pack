import { defineConfig } from 'tsup';

/**
 * Bundle the reach-up re-export shim (src/index.ts) into a FLAT dist/.
 *
 * tsup (esbuild + a dts pass) traces imports, so the engine closure
 * under ../../../src is pulled in automatically — including files the
 * old tsc `include` list omitted (e.g. server/aws-sigv4.ts). The things
 * kept external are node builtins (implicit), the OPTIONAL
 * peerDependencies (injected at runtime via a store interface, never
 * statically imported by the engine), and `@sammy-pack/sdk` — the
 * separately-versioned public contract the engine re-exports (the
 * queue-source narrow waist + the client signer) and declares as a real
 * dependency, so it resolves from the installed package, not inlined.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  external: ['better-sqlite3', 'pg', '@sammy-pack/sdk'],
});
