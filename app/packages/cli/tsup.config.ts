import { defineConfig } from 'tsup';

/**
 * Bundle the CLI into a FLAT, self-contained dist/.
 *
 * The CLI's two entry points — the `sammy` dispatcher (src/sammy.ts) and
 * the stdio MCP server (src/mcp.ts) — both reach UP out of the package
 * (`../../../src/*`) into the in-repo orchestration engine + server-side
 * run-runner glue. Those reach-up modules are NOT in the published cli
 * tarball, so without bundling the published MCP server is broken
 * ("Cannot find module '../../../src/...'").
 *
 * tsup (esbuild) traces those imports and inlines the engine + run-runner
 * glue into dist/. This intentionally DUPLICATES some engine code that
 * also lives in core's bundle — they are separate published artifacts.
 * We do NOT export this glue from core: createRunRunner /
 * makeLoadRunContext depend on the Claude Agent SDK, and core must stay
 * zero-dependency.
 *
 * EXTERNAL (resolved at runtime from cli's own deps, not inlined):
 *   - node builtins (implicit in esbuild's node platform)
 *   - @anthropic-ai/claude-agent-sdk  (run-runner → sdk-stream needs it)
 *   - @modelcontextprotocol/sdk       (the MCP server framework)
 *   - zod                             (tool input schemas)
 *   - better-sqlite3 / pg             (optional store backends, lazy-loaded)
 *
 * dts is intentionally OFF — the CLI is an app, not a typed SDK, so there
 * are no consumers of its types and no reason to pay the dts pass cost.
 */
export default defineConfig({
  entry: ['src/sammy.ts', 'src/mcp.ts'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  clean: true,
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@modelcontextprotocol/sdk',
    'zod',
    'better-sqlite3',
    'pg',
  ],
});
