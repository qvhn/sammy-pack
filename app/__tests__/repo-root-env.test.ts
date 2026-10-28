/**
 * Every entry point resolves the workspace the same way. The Vite dev server hands repoRoot() its real root
 * (app/web), so it has to honour SAMMY_REPO_ROOT itself; it used to ignore it and open the checkout's own
 * run store and triggers instead of the named workspace.
 */
import path from 'node:path';
import { repoRoot } from '../sammy-pack-api';

describe('repoRoot', () => {
  const saved = process.env.SAMMY_REPO_ROOT;
  afterEach(() => {
    if (saved === undefined) delete process.env.SAMMY_REPO_ROOT;
    else process.env.SAMMY_REPO_ROOT = saved;
  });

  it('is two levels above the Vite root when SAMMY_REPO_ROOT is unset', () => {
    delete process.env.SAMMY_REPO_ROOT;
    expect(repoRoot('/opt/checkout/app/web')).toBe(path.resolve('/opt/checkout'));
  });

  it('is SAMMY_REPO_ROOT when set, whatever root the dev server passes', () => {
    process.env.SAMMY_REPO_ROOT = '/srv/workspace';
    expect(repoRoot('/opt/checkout/app/web')).toBe(path.resolve('/srv/workspace'));
  });
});
