#!/usr/bin/env node
/**
 * `sammy` CLI launcher. Runs the BUILT JS entry (dist/sammy.js) directly —
 * no `tsx`, no runtime transpile. tsup bundles the engine + MCP glue into
 * dist/, so this works from a plain `npm i @sammy-pack/cli` install, not
 * just in-repo.
 *
 * The plugin's .mcp.json invokes this same file as
 *   node ${CLAUDE_PLUGIN_ROOT}/../bin/sammy.js mcp
 * so it stays the stable entry point for both the `sammy` bin and the
 * Claude Code plugin's MCP server.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'dist', 'sammy.js');

// Re-spawn node on the bundled entry, forwarding argv and inheriting
// stdio (the MCP server speaks JSON-RPC over stdin/stdout). Resolving the
// entry as an absolute path keeps this correct regardless of cwd and is
// safe on Windows (node accepts the absolute path directly; no shell).
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
child.on('error', err => {
  console.error(`[sammy] failed to launch ${entry}: ${err.message}`);
  process.exit(1);
});
