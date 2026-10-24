/**
 * CI gate: every shipped example orchestration must (a) pass the framework's
 * runtime validator and (b) reference only agents that actually exist.
 *
 * This is a stronger check than `examples.test.ts` (which only runs the schema
 * validator). It ADDS the agent-existence cross-reference — the class of bug
 * where an example's JSON is schema-valid but points at an `agents/<name>.md`
 * that was never created (so the run dies at dispatch with "Agent file not
 * found"). Three examples shipped broken in exactly this family; this test is
 * the regression guard.
 *
 * Scope = the TRACKED tree (what CI / a fresh clone sees), via `git ls-files`.
 * The `agents/` and `examples/` directories are .gitignore ALLOWLISTS: imported
 * domain sets (often symlinks into a consumer workspace) are excluded, so a
 * machine-local domain import can never make this generic check pass-or-fail
 * non-deterministically. We union in `git ls-files --others --exclude-standard`
 * so a newly-authored-but-not-yet-committed generic template (allowlisted) is
 * counted too — matching what WOULD be tracked.
 *
 * Agent resolution mirrors the framework: `validateAgentExistence` (src/
 * validate.ts) cross-references `collectAgentPaths(orchestration)` against the
 * known-agent set, skipping parameterized paths (`agents/${x}.md`) that only
 * resolve from run state. The known-agent set is `agents/<name>.md` for every
 * `.md` on disk except README — the same shape `run-context.ts` builds when it
 * loads agents for a real run.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  validateOrchestration,
  collectAgentPaths,
} from '../src/validate';
import type { Node } from '../src/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Files in `dir` that are tracked OR untracked-but-not-ignored (i.e. the
 *  allowlist-permitted set — what would be committed by an explicit add).
 *  Returned as repo-root-relative POSIX paths, matching how orchestration
 *  JSON references agents (`agents/foo.md`) and how examples are addressed. */
function allowlistedFiles(dir: string, ext: string): string[] {
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  const tracked = run(['ls-files', dir]);
  const untrackedNotIgnored = run([
    'ls-files',
    '--others',
    '--exclude-standard',
    dir,
  ]);
  return Array.from(new Set([...tracked, ...untrackedNotIgnored])).filter(f =>
    f.endsWith(ext),
  );
}

// Build the known-agent set: `agents/<name>.md` for every allowlisted agent
// markdown file except the directory README (mirrors run-context.ts, which
// skips readme.md when loading agents for a run).
const knownAgentPaths = new Set(
  allowlistedFiles('agents', '.md').filter(
    f => path.basename(f).toLowerCase() !== 'readme.md',
  ),
);

const exampleFiles = allowlistedFiles('examples', '.json');

describe('examples/ are valid + fully resolvable', () => {
  test('there is at least one tracked example and many known agents', () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
    // Sanity floor: if the agent set came back tiny, the git query is wrong
    // and every "missing agent" assertion below would be a false positive.
    expect(knownAgentPaths.size).toBeGreaterThan(10);
  });

  test.each(exampleFiles)('%s validates and resolves all agents', file => {
    const abs = path.join(REPO_ROOT, file);
    const raw = fs.readFileSync(abs, 'utf8');

    let parsed: Node;
    try {
      parsed = JSON.parse(raw) as Node;
    } catch (e) {
      throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
    }

    // (a) Schema / runtime validation — hard errors only. Warnings (e.g. a
    // route with no default, a non-Anthropic provider with Claude-only
    // features) are advisory and must not fail CI.
    const errors = validateOrchestration(parsed).filter(
      e => e.severity === 'error',
    );

    // (b) Agent existence — mirrors validateAgentExistence: every referenced
    // agent path must exist, skipping parameterized (`${...}`) refs that only
    // resolve from run state.
    const missingAgents = collectAgentPaths(parsed).filter(
      ref => !ref.includes('${') && !knownAgentPaths.has(ref),
    );

    if (errors.length > 0 || missingAgents.length > 0) {
      const parts: string[] = [];
      if (errors.length > 0) {
        parts.push(
          `${errors.length} validation error(s):\n` +
            errors.map(e => `  - ${e.path}: ${e.message}`).join('\n'),
        );
      }
      if (missingAgents.length > 0) {
        parts.push(
          `${missingAgents.length} unresolved agent reference(s):\n` +
            missingAgents
              .map(a => `  - ${a} (no such file in the agents allowlist)`)
              .join('\n'),
        );
      }
      throw new Error(`${file}:\n${parts.join('\n')}`);
    }
  });
});
