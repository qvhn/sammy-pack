import fs from 'node:fs';
import path from 'node:path';
import { SHORT_VALUE_MASK as SERVER_MASK } from '../src/server/credentials-store';
import { SHORT_VALUE_MASK as UI_MASK } from '../src/store/credentials';

/**
 * Server ⇄ editor parity for the short-value mask.
 *
 * The server masks a stored value too short to show a prefix of (≤ 8 chars)
 * to one fixed, synthetic token and recognises that token on PUT to restore
 * the real value. The browser bundle cannot import server code, so the
 * Connections editor carries its own copy of the literal — and a copy is
 * exactly the drift class `cli-parity.test.ts` polices: the editor shipped a
 * 6-dot mask against the server's 8-dot one, so one editor showed two
 * different "there is a value here" tokens and dressed a genuinely empty env
 * value up as a stored secret.
 *
 * Pinned at the SOURCE: both files must declare `SHORT_VALUE_MASK` with the
 * same literal, so a re-spelling on either side (or an alias that quietly
 * stops being the same string) fails here before it reaches a user.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_PATH = path.join(REPO_ROOT, 'app/src/server/credentials-store.ts');
const UI_PATH = path.join(REPO_ROOT, 'app/src/store/credentials.ts');

const DECL = /export const SHORT_VALUE_MASK = '([^']*)';/;

function declaredMask(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(DECL);
  if (!m) throw new Error(`${path.relative(REPO_ROOT, file)} no longer declares SHORT_VALUE_MASK`);
  return m[1];
}

describe('SHORT_VALUE_MASK — server ⇄ editor parity', () => {
  it('both source files declare the same literal', () => {
    expect(declaredMask(UI_PATH)).toBe(declaredMask(SERVER_PATH));
  });

  it('the exported constants agree with the declarations, and the mask is a real token', () => {
    expect(UI_MASK).toBe(SERVER_MASK);
    expect(UI_MASK).toBe(declaredMask(SERVER_PATH));
    // Non-empty — '' is what the server sends for "nothing stored", and the
    // whole point of the token is to be distinguishable from that.
    expect(UI_MASK).not.toBe('');
  });
});
