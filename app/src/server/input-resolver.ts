/**
 * Run-input resolver. Turns an orchestration's declared `inputs` (a Jira
 * ticket, a PRD/Confluence link, a URL, an uploaded doc) into plain-text
 * content keyed by input name, ready to seed into run state as `${name}`.
 *
 * This is the EXECUTION-side counterpart to the file-extractor that powers
 * generate-from-doc: there a dropped file becomes an orchestration; here a
 * referenced ticket/doc becomes the input an orchestration works on.
 *
 * Server-only (does network + reuses the file extractor). Throws on a
 * missing required input or an unresolvable reference so the run is refused
 * with a clear error rather than silently working on nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InputDecl } from '../types';
import { extractFromUpload } from './file-extractor';

/** Per-ticket attachment limits: enough for screenshots, logs and design
 *  assets, not a way to pull a whole drive onto the server. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** No input fetch may hold a run start longer than this. */
const FETCH_TIMEOUT_MS = 30_000;

/** A response body, refusing more than `cap` bytes as they arrive. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const reader = (res.body as ReadableStream<Uint8Array> | null | undefined)?.getReader?.();
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > cap) throw new Error(`over the ${cap}-byte limit`);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new Error(`over the ${cap}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type InputValue = {
  /** Raw value for text/url/jira/confluence/github (the string / id / url). */
  value?: string;
  /** Uploaded file for kind:'file'. */
  file?: { filename: string; mime: string; bytes: Buffer };
};

export type ResolveDeps = {
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Atlassian creds for jira/confluence (site, account email, API token). */
  atlassian?: { site: string; email: string; token: string };
  /** GitHub token for github issues/PRs (optional for public repos). */
  github?: { token: string };
  /** Where a jira input's attachments are saved (`<dir>/<KEY>/<file>`).
   *  Unset → attachments are listed by name only. */
  attachmentsDir?: string;
};

export async function resolveInputs(
  decls: InputDecl[],
  values: Record<string, InputValue>,
  deps: ResolveDeps = {},
): Promise<Record<string, string>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const out: Record<string, string> = {};
  for (const decl of decls) {
    const v = values[decl.name];
    const provided = !!v && (v.value != null || v.file != null);
    if (!provided) {
      if (decl.required) {
        throw new Error(
          `required input "${decl.name}" (${decl.kind}) was not provided`,
        );
      }
      continue;
    }
    out[decl.name] = await resolveOne(decl, v as InputValue, deps, fetchImpl);
  }
  return out;
}

async function resolveOne(
  decl: InputDecl,
  v: InputValue,
  deps: ResolveDeps,
  fetchImpl: typeof fetch,
): Promise<string> {
  switch (decl.kind) {
    case 'text':
      return v.value ?? '';

    case 'url': {
      const res = await fetchImpl(v.value as string, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok)
        throw new Error(
          `input "${decl.name}": GET ${v.value} → HTTP ${res.status}`,
        );
      return await res.text();
    }

    case 'jira': {
      // A ticket input takes whatever people naturally paste: a Jira key or
      // link → the issue (below); a GitHub issue / PR link → that; any other
      // link → its text; a sentence or more → the work in their own words.
      // Anything shaped like a key that is not one (`PROJ123`, `PROJ 123`)
      // is refused, not quietly treated as prose.
      const raw = (v.value ?? '').trim();
      if (!raw) throw new Error(`input "${decl.name}": empty`);
      const isUrl = /^https?:\/\//i.test(raw);
      const siteHost = deps.atlassian ? hostOf(deps.atlassian.site) : null;
      const jiraRef = isUrl
        ? (siteHost !== null && hostOf(raw) === siteHost) ||
          /(atlassian\.net\/|\/browse\/[A-Za-z][A-Za-z0-9_]*-\d+|\/issues\/[A-Za-z][A-Za-z0-9_]*-\d+|selectedIssue=)/i.test(raw)
        : JIRA_KEY_RE.test(raw);
      if (!jiraRef) {
        if (isUrl && /github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+/i.test(raw)) {
          return resolveOne({ ...decl, kind: 'github' }, v, deps, fetchImpl);
        }
        if (isUrl) return resolveOne({ ...decl, kind: 'url' }, v, deps, fetchImpl);
        if (raw.split(/\s+/).length < 3 || /^[A-Za-z][A-Za-z0-9_]*[\s_]?\d+$/.test(raw)) {
          throw new Error(
            `input "${decl.name}": "${raw}" is not a Jira key (like ABC-123), a link, or a description — ` +
              'give the key or link, or describe the work in a sentence',
          );
        }
        return `Ticket (described by the person who started the run — there is no tracker issue):\n\n${raw}`;
      }
      const a = deps.atlassian;
      if (!a)
        throw new Error(
          `input "${decl.name}": no Atlassian credential configured for a jira input`,
        );
      const key = extractJiraKey(v.value as string);
      const url = `${trimSlash(a.site)}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,attachment`;
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: basicAuth(a.email, a.token), Accept: 'application/json' },
      });
      if (!res.ok) {
        // Jira answers 404 both for a key that does not exist and for an issue
        // this account cannot see — name both, and the account, so the fix is
        // obvious (a typo, or a missing project permission).
        throw new Error(
          res.status === 404
            ? `input "${decl.name}": Jira has no issue ${key} that ${a.email} can see — check the key, or that this account has access to its project`
            : res.status === 401 || res.status === 403
              ? `input "${decl.name}": Jira refused ${a.email} (HTTP ${res.status}) — check the API token on the Connections page`
              : `input "${decl.name}": Jira ${key} → HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as {
        key?: string;
        fields?: {
          summary?: string;
          description?: unknown;
          status?: { name?: string };
          issuetype?: { name?: string };
          attachment?: JiraAttachment[];
        };
      };
      const f = j.fields ?? {};
      const attachments = await saveJiraAttachments(
        j.key ?? key,
        f.attachment ?? [],
        a,
        deps.attachmentsDir,
        fetchImpl,
      );
      return [
        `${j.key ?? key} — ${f.summary ?? '(no summary)'}`,
        `Type: ${f.issuetype?.name ?? '?'} · Status: ${f.status?.name ?? '?'}`,
        `Link: ${trimSlash(a.site)}/browse/${j.key ?? key}`,
        '',
        adfToText(f.description),
        ...(attachments ? ['', attachments] : []),
      ].join('\n');
    }

    case 'confluence': {
      const a = deps.atlassian;
      if (!a)
        throw new Error(
          `input "${decl.name}": no Atlassian credential configured for a confluence input`,
        );
      const id = extractConfluenceId(v.value as string);
      const url = `${trimSlash(a.site)}/wiki/rest/api/content/${encodeURIComponent(id)}?expand=body.storage`;
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Authorization: basicAuth(a.email, a.token), Accept: 'application/json' },
      });
      if (!res.ok)
        throw new Error(`input "${decl.name}": Confluence ${id} → HTTP ${res.status}`);
      const j = (await res.json()) as {
        title?: string;
        body?: { storage?: { value?: string } };
      };
      return `${j.title ?? id}\n\n${stripHtml(j.body?.storage?.value ?? '')}`;
    }

    case 'github': {
      const t = deps.github?.token;
      const url = toGithubApi(decl.name, v.value as string);
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
        },
      });
      if (!res.ok)
        throw new Error(
          res.status === 404
            ? `input "${decl.name}": GitHub has no ${v.value} that this server can see — if the repository is private, add a GitHub connection or log in with \`gh auth login\``
            : `input "${decl.name}": GitHub ${v.value} → HTTP ${res.status}`,
        );
      const j = (await res.json()) as {
        number?: number;
        title?: string;
        body?: string;
        state?: string;
      };
      return `#${j.number ?? '?'} ${j.title ?? ''} (${j.state ?? '?'})\n\n${j.body ?? ''}`;
    }

    case 'file': {
      if (!v.file) throw new Error(`input "${decl.name}": no file uploaded`);
      const r = await extractFromUpload(v.file.filename, v.file.mime, v.file.bytes);
      const text = r.blocks
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n\n');
      return text || r.summary;
    }

    default:
      return v.value ?? '';
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/$/, '');
}
function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}
function extractJiraKey(s: string): string {
  // Jira keys are PROJ-123. Match case-insensitively so a pasted lowercase id
  // or a browse URL (…/browse/proj-123?focused=…) still resolves, and
  // normalize to the canonical UPPERCASE the REST API expects.
  // A board link carries the issue as `selectedIssue=KEY`; the path before it
  // can hold other key-shaped tokens, so that parameter wins.
  const sel = s.match(/selectedIssue=([A-Za-z][A-Za-z0-9_]*-\d+)/);
  if (sel) return sel[1].toUpperCase();
  const m = s.match(/[A-Za-z][A-Za-z0-9_]*-\d+/);
  return m ? m[0].toUpperCase() : s.trim();
}
function extractConfluenceId(s: string): string {
  const m = s.match(/pageId=(\d+)/) || s.match(/\/(\d+)(?:\/|$)/);
  return m ? m[1] : s.trim();
}
/** The ONE destination a `github` input may be fetched from. The github kind
 *  carries a single secret (a PAT) and no base-URL field, so api.github.com
 *  is its only legitimate host — the same origin the registry's own test
 *  probe uses. */
const GITHUB_API_ORIGIN = 'https://api.github.com';

/** The only endpoints a `github` input needs: one issue or one pull request.
 *  That is the shape `toGithubApi` BUILDS, and the resolver projects only
 *  `number` / `title` / `body` / `state` out of the response — so it is also
 *  the only shape the already-canonical passthrough may accept. */
const GITHUB_ISSUE_OR_PULL_PATH = /^\/repos\/[^/]+\/[^/]+\/(issues|pulls)\/\d+$/;

/** TOTAL by construction: every value either becomes a `GITHUB_API_ORIGIN`
 *  URL or is refused.
 *
 *  A non-matching value used to be returned VERBATIM, and the `github` branch
 *  above then fetched it with `Authorization: Bearer <stored PAT>` — so
 *  whoever supplied the value chose the DESTINATION, and one
 *  POST /api/runs/start delivered a stored credential in plaintext to any
 *  host. The lookalike `https://github.com.evil.example/o/r/issues/1` misses
 *  the regex, so a pasted link was enough; nothing else refused it either,
 *  because the only thing that ever rejected a value was WHATWG URL parsing
 *  inside fetch. This is the rule /api/credentials/test states as its
 *  DESTINATION RULE, applied to the other seam that attaches a stored secret
 *  to an outbound request. (The jira / confluence branches build their URL
 *  from the credential's own `site`, so a caller cannot redirect those; the
 *  `url` kind fetches a caller's URL but attaches no credential.) */
function toGithubApi(name: string, s: string): string {
  // https://github.com/owner/repo/issues/123 → api.github.com/repos/owner/repo/issues/123
  // Case-INSENSITIVE: a host is case-insensitive and `new URL()` lowercases
  // it, so a pasted `https://GitHub.com/…` missed a case-sensitive match and
  // was refused by a message naming exactly what it was given. Every gate in
  // this repo classifies case-folded for the same reason.
  const m = s.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i);
  // `[^/]+` also admits `.` / `..` / `%2e%2e`, which walk the built path off
  // `/repos/` while the input still reads as a github.com issue URL — so the
  // caller would still be picking the endpoint the PAT hits. A real owner /
  // repo is never a relative segment.
  if (m && !isRelativeSegment(m[1]) && !isRelativeSegment(m[2])) {
    const kind = m[3].toLowerCase() === 'pull' ? 'pulls' : 'issues';
    return `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}/${kind}/${m[4]}`;
  }
  // An already-canonical API URL is the one other value that was legitimately
  // usable before, so it keeps working — by its ORIGIN, never by a substring,
  // and only for the PATHS this kind needs. Accepting any api.github.com path
  // granted outright what the relative-segment guard above refuses: the
  // caller chose the endpoint the stored PAT hits (`/user/emails`,
  // `/orgs/<o>/members/<u>`, a private repo's `/contents/.env`), and because
  // a refusal reports the upstream status (`→ HTTP 404`), that made the
  // server's PAT an existence oracle for anyone who can declare an input.
  let parsed: URL | null = null;
  try {
    parsed = new URL(s);
  } catch {
    /* not a URL at all */
  }
  if (
    parsed &&
    parsed.origin === GITHUB_API_ORIGIN &&
    GITHUB_ISSUE_OR_PULL_PATH.test(parsed.pathname)
  ) {
    return s;
  }
  throw new Error(
    `input "${name}": not a GitHub issue/PR reference — expected a ` +
      `github.com issue/PR URL, or the ${GITHUB_API_ORIGIN} form ` +
      `/repos/<owner>/<repo>/{issues,pulls}/<number>. The stored GitHub ` +
      `credential is only ever sent to ${GITHUB_API_ORIGIN}.`,
  );
}
/** A path segment that resolves to somewhere else — `.`, `..`, and their
 *  percent-encoded spellings. */
function isRelativeSegment(seg: string): boolean {
  const decoded = seg.replace(/%2e/gi, '.');
  return decoded === '.' || decoded === '..';
}
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function adfToText(adf: unknown): string {
  // Atlassian Document Format → flat text (best-effort).
  if (typeof adf === 'string') return adf;
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { text?: string; content?: unknown[] };
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(adf);
  return parts.join(' ').trim();
}

type JiraAttachment = { id?: string; filename?: string; mimeType?: string; size?: number };

/**
 * Download a ticket's attachments so the agents working on it can use them
 * (an icon to put on the page, a screenshot of the bug, a log). The issue
 * API lists them, but their content needs the same authenticated session —
 * an agent's own fetch of the URL fails — so the resolver fetches them here
 * and hands over local paths. Returns the text block listing them, or ''.
 */
async function saveJiraAttachments(
  key: string,
  list: JiraAttachment[],
  a: { site: string; email: string; token: string },
  dir: string | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (list.length === 0) return '';
  const lines: string[] = [];
  // A folder of its own per resolution: two runs of one ticket never share
  // (or overwrite) each other's copies.
  const target = dir
    ? path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, '-')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)
    : null;
  if (target && dir) {
    await pruneOldAttachments(dir);
    await fs.mkdir(target, { recursive: true });
  }
  // Saved under the attachment's own (shell-safe) name — that is the name an
  // agent will copy into the repository — prefixed with its id only when two
  // attachments on the ticket share one.
  const used = new Set<string>();
  for (const [i, att] of list.entries()) {
    const name = att.filename ?? `attachment-${att.id ?? i}`;
    const meta = `${att.mimeType ?? 'unknown type'}, ${formatSize(att.size ?? 0)}`;
    if (!target || !att.id) {
      lines.push(`- ${name} (${meta}) — not downloaded`);
      continue;
    }
    if (i >= MAX_ATTACHMENTS || (att.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      lines.push(`- ${name} (${meta}) — skipped (over the ${MAX_ATTACHMENTS}-file / ${formatSize(MAX_ATTACHMENT_BYTES)} limit)`);
      continue;
    }
    try {
      const res = await fetchImpl(
        `${trimSlash(a.site)}/rest/api/3/attachment/content/${encodeURIComponent(att.id)}`,
        {
          headers: { Authorization: basicAuth(a.email, a.token), Accept: '*/*' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The listed size is the server's claim; the cap holds on the bytes.
      const bytes = await readCapped(res, MAX_ATTACHMENT_BYTES);
      const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-');
      const file = path.join(target, used.has(safe) ? `${att.id}-${safe}` : safe);
      used.add(safe);
      await fs.writeFile(file, bytes);
      lines.push(`- ${file} (${meta})`);
    } catch (err) {
      lines.push(`- ${name} (${meta}) — download failed: ${(err as Error).message}`);
    }
  }
  return (
    'Attachments (downloaded from the ticket — copy into the repository whatever the ticket asks you to use):\n' +
    lines.join('\n')
  );
}

function formatSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** A Jira issue key: project key (letters, digits, `_`) + `-` + number. */
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Attachment folders are per resolution (a run's resume reads its own), so
 *  they would pile up: drop the ones older than a week — far past any run
 *  that is still paused on them in practice. Best-effort. */
const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
async function pruneOldAttachments(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - ATTACHMENT_RETENTION_MS;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    const st = await fs.stat(full).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}
