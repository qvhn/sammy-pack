/**
 * The standalone worker's budget gate must be OWNER-scoped.
 *
 * The cap went per-owner (`loadBudgetState(file, store, ownerId)`) so one
 * team's runaway sweep cannot refuse every other team's runs. The server's
 * fireRun passes the owner; the worker's two call sites — the primary
 * delivery path and the errorOrchestration recovery path — did not, so on the
 * recommended multi-worker topology the cap was still workspace-global.
 *
 * worker.ts is a script (it calls main() on import), so this pins the call
 * sites at the source level — the same way cli-parity.test.ts pins the
 * executor's surface.
 */

import fs from 'node:fs';
import path from 'node:path';

const WORKER_PATH = path.resolve(__dirname, '..', 'worker.ts');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

describe('worker.ts budget gate', () => {
  const calls = source.match(/loadBudgetState\([^)]*\)/g) ?? [];

  it('loads the budget state at both run paths (delivery + recovery)', () => {
    expect(calls.length).toBe(2);
  });

  it('passes the run owner at EVERY call site — never the workspace-global cap', () => {
    for (const call of calls) {
      expect(call).toMatch(
        /^loadBudgetState\(\s*budgetFile,\s*store,\s*(d\.ownerId|owner)\s*\)$/,
      );
    }
  });
});
