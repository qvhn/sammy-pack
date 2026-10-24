/**
 * CI gate: no real secret may be committed to the tracked tree.
 *
 * Scans every TRACKED file (`git ls-files`) for high-confidence
 * provider-token patterns — the same prefix families the runtime scrubber
 * redacts (src/server/scrub-secrets.ts) — and fails the build if any match
 * looks like a *real* credential.
 *
 * The hard part is the false-positive rate: the repo legitimately contains
 * synthetic tokens in its own security tests (scrub-secrets, credential-*),
 * docs, and examples. So a raw pattern match is NOT a failure on its own —
 * a match only fails when it ALSO looks real, i.e. it is NOT:
 *   - an obvious placeholder (EXAMPLE / FAKE / REPLACE_ME / xxx / your-… etc.),
 *   - a low-entropy / sequential / repeated synthetic string
 *     (`0123456789…`, `aaaa…`, `abcdef…`, dictionary-word tokens), or
 *   - inside a known security-test fixture file (which exists precisely to
 *     carry these patterns).
 *
 * This deliberately uses only the high-confidence PREFIXED patterns
 * (Atlassian, Anthropic, OpenAI, GitHub, AWS, GitLab, Slack, Google, Figma,
 * Linear, Notion, PEM private keys). It does NOT include the
 * scrubber's generic "40+ char blob" fallback — at hygiene-scan scope that
 * over-matches minified bundles, lockfile hashes, and base64 assets, which
 * would make the gate noisy and untrustworthy.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Real-secret patterns. Each `name` is for the failure message; each `re`
 *  is a global regex matching the token (prefix + a high-entropy body long
 *  enough to be a real credential). Mirrors the families in
 *  server/scrub-secrets.ts. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Atlassian API tokens (Jira / Confluence) — ATATT… / ATCTT….
  { name: 'Atlassian API token', re: /\bAT(?:ATT|CTT)[A-Za-z0-9._=-]{16,}/g },
  // Anthropic API keys.
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI API keys (sk-… / sk-proj-…).
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  // GitHub tokens — classic PAT / OAuth / user / server / refresh.
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // GitHub fine-grained PATs.
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  // AWS access key ids — prefix + exactly 16 uppercase alnum.
  {
    name: 'AWS access key id',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  // GitLab PATs.
  { name: 'GitLab PAT', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  // Slack tokens.
  { name: 'Slack token', re: /\bxox[bporas]-[A-Za-z0-9-]{10,}/g },
  // Google API keys.
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  // Figma personal access tokens.
  { name: 'Figma PAT', re: /\bfigd_[A-Za-z0-9_-]{20,}/g },
  // Linear API keys.
  { name: 'Linear API key', re: /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g },
  // Notion integration secrets (legacy `secret_` / newer `ntn_`).
  { name: 'Notion secret', re: /\b(?:secret_|ntn_)[A-Za-z0-9]{32,}/g },
  // Private key PEM blocks — the header alone is enough to flag.
  {
    name: 'private key (PEM)',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
];

/** Substrings that mark a match as a deliberate placeholder / fixture rather
 *  than a real secret. Case-insensitive. AWS's documented dummy key
 *  (AKIAIOSFODNN7EXAMPLE) is covered by `example`. */
const PLACEHOLDER_MARKERS = [
  'example',
  'fake',
  'dummy',
  'placeholder',
  'sample',
  'replace',
  'changeme',
  'your-',
  'your_',
  'yourtoken',
  'redacted',
  'xxxx',
  'notreal',
  'test',
  'foobar',
  'supersecret', // used by the credential-injection fixtures
  'brandnew', // used by the credential-mask rotation fixtures
  'rotated',
  'specimen',
];

/** Files that legitimately contain synthetic secret patterns — the scrubber /
 *  credential security tests. They exist to exercise these very patterns, so
 *  matches inside them are expected. Matched as repo-root-relative paths. */
const FIXTURE_ALLOWLIST = new Set([
  'app/__tests__/scrub-secrets.test.ts',
  'app/__tests__/credential-mask.test.ts',
  'app/__tests__/credential-injection.test.ts',
  'app/__tests__/credential-env.test.ts',
  // This very test embeds example tokens in its own comments/markers.
  'app/__tests__/secret-hygiene.test.ts',
]);

/** True if the token body is low-entropy / clearly synthetic: sequential
 *  runs (0123456789 / abcdef…), a single repeated char, or otherwise not
 *  plausibly random. Real high-entropy tokens trip none of these. */
function looksSynthetic(token: string): boolean {
  const lower = token.toLowerCase();
  if (PLACEHOLDER_MARKERS.some(m => lower.includes(m))) return true;
  // Sequential ascending runs commonly used in fixtures.
  if (/0123456789|abcdefghij|abcdef[0-9]/.test(lower)) return true;
  if (/(?:^|[-_])(?:abc|abcd|abcde|abcdef|xyz)(?:[-_]|$)/.test(lower)) return true;
  // Any character repeated 6+ times in a row (e.g. gho_aaaaaaaa…).
  if (/(.)\1{5,}/.test(token)) return true;
  // Body after the prefix is too uniform: take the part after the first
  // separator and check character variety. A genuinely random token has many
  // distinct chars; "AbCdEf012345678ghi" / dictionary-ish bodies have few.
  const body = token.replace(/^[A-Za-z0-9]+[-_]/, '');
  if (body.length >= 12) {
    const distinct = new Set(body.replace(/[^A-Za-z0-9]/g, '')).size;
    if (distinct > 0 && distinct < 12) return true;
  }
  return false;
}

/** Read a tracked file as UTF-8 text, or null if it's a symlink, binary,
 *  oversized, or unreadable (nothing to scan in those cases). */
function readTextFile(abs: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  if (st.size > 3_000_000) return null; // skip huge generated/bundle files
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  // Heuristic binary check: a NUL byte in the first 8KB.
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

describe('secret hygiene — no real credentials in the tracked tree', () => {
  const files = trackedFiles();

  test('git ls-files returned a sane file list', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  test('no likely-real secret is committed', () => {
    type Finding = { file: string; kind: string; sample: string };
    const findings: Finding[] = [];

    for (const file of files) {
      if (FIXTURE_ALLOWLIST.has(file)) continue;
      const text = readTextFile(path.join(REPO_ROOT, file));
      if (text === null) continue;

      for (const { name, re } of SECRET_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const token = m[0];
          // PEM headers carry no entropy body — flag them outright (a real
          // committed private key is always a problem; the fixture allowlist
          // already exempts the security tests).
          const isPem = name.startsWith('private key');
          if (!isPem && looksSynthetic(token)) continue;
          findings.push({
            file,
            kind: name,
            // Never echo a full real-looking secret into CI logs — show a
            // short, masked sample that still IDs the line.
            sample: token.slice(0, 8) + '…(' + token.length + ' chars)',
          });
        }
      }
    }

    if (findings.length > 0) {
      const report = findings
        .map(f => `  - ${f.file}: ${f.kind} [${f.sample}]`)
        .join('\n');
      throw new Error(
        `Found ${findings.length} likely-real secret(s) in tracked files. ` +
          `Rotate the credential, remove it from the tree, and (if it's a ` +
          `genuine fixture) add an allowance:\n${report}`,
      );
    }
  });
});
