/**
 * The `http` leaf — one HTTP request as a phase, with no model in the loop.
 *
 * What it is for: the deterministic edges of an automation — write a status
 * back to the system that raised the event, post to a chat webhook, call an
 * internal API — where spending an agent turn (and trusting it to format a
 * curl command) buys nothing.
 *
 * Guard rails, all on by default:
 *   - HOST ALLOWLIST. The target host must be named by the node's
 *     `allowHosts` or by `SAMMY_HTTP_ALLOWED_HOSTS`; with neither, the request
 *     is refused. URLs are interpolated from run state — which can carry an
 *     inbound payload — so without this an event could point the request at
 *     any address the server can reach.
 *   - NO REDIRECTS. A 3xx is returned as-is (a failure unless listed in
 *     `expectStatus`), so an allowed host cannot bounce the request — and its
 *     credentials — to one that is not.
 *   - SECRETS COME FROM THE TEMPLATE ONLY. `${connections:<name>.<field>}`
 *     refs are resolved on the author's template BEFORE run state is
 *     interpolated, so a value arriving in a payload cannot name a credential
 *     and have it filled in. Every resolved secret is reported back so the
 *     executor scrubs it from the run's output.
 *   - BOUNDED. Per-request timeout and a response-size cap.
 *
 * Browser-safe: global `fetch` only, no Node imports (the executor is bundled
 * for the web UI too).
 */

import type { HttpBody } from '../types';
import {
  interpolate,
  resolveConnectionRefs,
  resolveRef,
  type ConnectionsMap,
  type State,
} from './interpolate';

export const HTTP_DEFAULT_TIMEOUT_SECONDS = 30;
export const HTTP_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const WHOLE_REF = /^\$\{([^}]+)\}$/;
const CONN_REF = /\$\{connections:([^}]+)\}/g;

/** Hosts allowed by `SAMMY_HTTP_ALLOWED_HOSTS` (comma / space separated). */
export function envAllowedHosts(): string[] {
  const raw = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)
    ?.env?.SAMMY_HTTP_ALLOWED_HOSTS;
  return (raw ?? '')
    .split(/[\s,]+/)
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
}

/** `host` matches an allowlist entry: exact, or `*.example.com` for any
 *  subdomain (not the apex itself). */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some(entry => {
    const e = entry.toLowerCase().replace(/\.$/, '');
    if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

export type PreparedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Multipart instead of `body`: text fields + artifact file parts (the
   *  artifact CONTENT is attached by the caller, which owns the run's
   *  artifacts — see `HttpBody.files`). */
  form?: {
    fields: Record<string, string>;
    files: Array<{ field: string; artifact: string; filename: string }>;
  };
  /** Plaintext credential values resolved into the request — for scrubbing. */
  secrets: string[];
  /** `${…}` refs that did not resolve against run state. */
  unresolved: string[];
};

/** Resolve the template's connection refs first, recording each value. */
function withConnections(
  template: string,
  connections: ConnectionsMap,
  secrets: Set<string>,
): string {
  if (!template.includes('${connections:')) return template;
  for (const m of template.matchAll(CONN_REF)) {
    const one = resolveConnectionRefs(m[0], connections);
    if (one !== m[0] && one.length >= 4) secrets.add(one);
  }
  return resolveConnectionRefs(template, connections);
}

/** Interpolate one string against run state. A string that is EXACTLY one
 *  `${ref}` yields the referenced VALUE (so a JSON body field can receive a
 *  number or an object); anything else renders as a string. */
function renderLeaf(
  template: string,
  state: State,
  connections: ConnectionsMap,
  secrets: Set<string>,
  unresolved: string[],
): unknown {
  const t = withConnections(template, connections, secrets);
  const whole = WHOLE_REF.exec(t);
  if (whole && !whole[1].trim().startsWith('connections:')) {
    const v = resolveRef(state, whole[1]);
    if (v !== undefined) return v;
  }
  return interpolate(t, state, ref => unresolved.push(ref));
}

function renderDeep(
  value: unknown,
  state: State,
  connections: ConnectionsMap,
  secrets: Set<string>,
  unresolved: string[],
): unknown {
  if (typeof value === 'string') return renderLeaf(value, state, connections, secrets, unresolved);
  if (Array.isArray(value)) {
    return value.map(v => renderDeep(v, state, connections, secrets, unresolved));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        renderDeep(v, state, connections, secrets, unresolved),
      ]),
    );
  }
  return value;
}

/** A request-building refusal. Its message has every credential resolved so
 *  far redacted, and `secrets` carries them so the caller can scrub the run. */
export class HttpPrepareError extends Error {
  constructor(
    message: string,
    readonly secrets: string[],
  ) {
    super(message);
  }
}

/** Build the concrete request from the node and run state, and check it
 *  against the allowlist. Throws an `HttpPrepareError` with an actionable —
 *  and credential-free — message on refusal: the URL in such a message has
 *  already had its `${connections:…}` refs resolved. */
export function prepareHttpRequest(
  spec: HttpBody,
  state: State,
  connections: ConnectionsMap,
  envHosts: readonly string[] = envAllowedHosts(),
): PreparedRequest {
  const secrets = new Set<string>();
  try {
    return prepareInner(spec, state, connections, envHosts, secrets);
  } catch (err) {
    let msg = (err as Error).message;
    for (const sec of [...secrets].sort((a, b) => b.length - a.length)) {
      msg = msg.split(sec).join('[REDACTED]');
    }
    throw new HttpPrepareError(msg, [...secrets]);
  }
}

function prepareInner(
  spec: HttpBody,
  state: State,
  connections: ConnectionsMap,
  envHosts: readonly string[],
  secrets: Set<string>,
): PreparedRequest {
  const unresolved: string[] = [];
  const str = (t: string) =>
    interpolate(withConnections(t, connections, secrets), state, ref => unresolved.push(ref));

  // The URL is rendered with every value that lands in the PATH or QUERY
  // percent-encoded: a payload value like `../../admin?x=` must not rewrite
  // the request's path on an allowed host (with its credentials attached).
  // A ref in the scheme/host part (`${vars.baseUrl}/x`) stays raw.
  const url = renderUrl(withConnections(spec.url, connections, secrets), state, unresolved);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`http: "${url}" is not an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`http: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('http: credentials in the URL are not allowed — use a header');
  }
  const allow = [...envHosts, ...(spec.allowHosts ?? [])];
  if (allow.length === 0) {
    throw new Error(
      `http: no allowed hosts — add "${parsed.hostname}" to this node's allowHosts ` +
        'or to SAMMY_HTTP_ALLOWED_HOSTS',
    );
  }
  if (!hostAllowed(parsed.hostname, allow)) {
    throw new Error(
      `http: host "${parsed.hostname}" is not allowed (allowed: ${allow.join(', ')})`,
    );
  }

  const method = (spec.method ?? 'GET').toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) {
    throw new Error(`http: unsupported method ${method}`);
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = str(String(v));

  if (spec.auth?.basic) {
    if (Object.keys(headers).some(h => h.toLowerCase() === 'authorization')) {
      throw new Error('http: set either auth.basic or an Authorization header, not both');
    }
    const user = str(String(spec.auth.basic.username ?? ''));
    const pass = str(String(spec.auth.basic.password ?? ''));
    const token = base64Utf8(`${user}:${pass}`);
    // The encoded form is as secret as the password it carries.
    secrets.add(token);
    headers.Authorization = `Basic ${token}`;
  }

  if (spec.files && spec.files.length > 0) {
    if (method === 'GET') throw new Error('http: files need a non-GET method');
    if (typeof spec.body === 'string') {
      throw new Error('http: with files, body must be an object (its fields become form fields)');
    }
    if (Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
      throw new Error('http: with files, do not set content-type — the multipart boundary is set for you');
    }
    const fields: Record<string, string> = {};
    if (spec.body && !Array.isArray(spec.body)) {
      const rendered = renderDeep(spec.body, state, connections, secrets, unresolved) as Record<string, unknown>;
      for (const [k, v] of Object.entries(rendered)) fields[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    const files = spec.files.map(f => ({
      field: f.field ?? 'file',
      artifact: f.artifact,
      filename: f.filename ? str(f.filename) : `${f.artifact.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`,
    }));
    if (unresolved.length > 0) {
      throw new Error(
        `http: unresolved reference(s) ${[...new Set(unresolved)].map(r => '${' + r + '}').join(', ')} — ` +
          'refusing to send a request with literal placeholders',
      );
    }
    return { url: parsed.toString(), method, headers, form: { fields, files }, secrets: [...secrets], unresolved };
  }

  let body: string | undefined;
  if (spec.body !== undefined && method !== 'GET') {
    if (typeof spec.body === 'string') {
      body = str(spec.body);
    } else {
      body = JSON.stringify(renderDeep(spec.body, state, connections, secrets, unresolved));
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
  }
  if (unresolved.length > 0) {
    // A write-back with a literal `${…}` in it is a silent wrong write:
    // refuse to send it.
    throw new Error(
      `http: unresolved reference(s) ${[...new Set(unresolved)].map(r => '${' + r + '}').join(', ')} — ` +
        'refusing to send a request with literal placeholders',
    );
  }
  return { url: parsed.toString(), method, headers, body, secrets: [...secrets], unresolved };
}

const REF_ANY = /\$\{([^}]+)\}/g;

/** Interpolate a URL template. Where a value lands decides how it is encoded:
 *   - at the very start (`${vars.baseUrl}/x`): raw — the author's base URL;
 *   - in the query or fragment: fully percent-encoded (no `&admin=true`);
 *   - anywhere else (path, or right after the host — `${base}${path}`,
 *     `http://${host}:8080/`): everything that could redirect the request is
 *     encoded — `?`, `#`, `@`, `\`, whitespace — while `/`, `:` and `[ ]`
 *     stay, so paths, ports and IPv6 hosts work; a `..` segment is refused.
 *     The resulting host is then held to the allowlist. A value placed right
 *     after the host can choose any path ON that host — put a literal path
 *     segment in the template before it to bound where it can point. */
function renderUrl(template: string, state: State, unresolved: string[]): string {
  let out = '';
  let last = 0;
  for (const m of template.matchAll(REF_ANY)) {
    out += template.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const v = resolveRef(state, m[1]);
    if (v === undefined) {
      unresolved.push(m[1].trim());
      out += m[0];
      continue;
    }
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (out === '') {
      out += text;
      continue;
    }
    const scheme = out.indexOf('://');
    const afterScheme = scheme === -1 ? 0 : scheme + 3;
    const inQuery = /[?#]/.test(out.slice(afterScheme));
    if (inQuery) {
      out += encodeURIComponent(text);
    } else {
      if (text.split(/[\\/]/).some(seg => seg === '..' || seg === '.')) {
        throw new Error(`http: a value interpolated into the URL path contains a ".." segment: ${JSON.stringify(text)}`);
      }
      out += encodeURIComponent(text).replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%5B/gi, '[').replace(/%5D/gi, ']');
    }
  }
  return out + template.slice(last);
}

/** base64 of the UTF-8 bytes — browser-safe (no Buffer). */
function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type HttpResult = { status: number; body: string; truncated: boolean };

/** Perform a prepared request with a timeout, no redirects, and a size cap on
 *  the body read. `signal` aborts it (run cancellation). */
export async function performHttpRequest(
  req: PreparedRequest,
  opts: {
    timeoutSeconds?: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    /** Content of a run artifact by name, for `form` file parts. */
    fileContent?: (artifact: string) => { text: string; mediaType: string } | undefined;
  } = {},
): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (!doFetch) throw new Error('http: no fetch available on this surface');
  const timeoutMs = Math.max(1, (opts.timeoutSeconds ?? HTTP_DEFAULT_TIMEOUT_SECONDS) * 1000);
  const cap = Math.max(1, opts.maxResponseBytes ?? HTTP_DEFAULT_MAX_RESPONSE_BYTES);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  const onAbort = () => ac.abort(opts.signal?.reason ?? new Error('cancelled'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let payload: string | FormData | undefined = req.body;
    if (req.form) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(req.form.fields)) fd.append(k, v);
      for (const f of req.form.files) {
        const content = opts.fileContent?.(f.artifact);
        if (content === undefined) {
          throw new Error(`http: no artifact named "${f.artifact}" in this run to upload`);
        }
        fd.append(f.field, new Blob([content.text], { type: content.mediaType }), f.filename);
      }
      payload = fd;
    }
    const res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: payload,
      redirect: 'manual',
      signal: ac.signal,
    });
    let text = '';
    let truncated = false;
    const reader = res.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > cap) {
          const keep = value.byteLength - (bytes - cap);
          text += decoder.decode(value.subarray(0, Math.max(0, keep)));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      if (!truncated) text += decoder.decode();
    } else {
      text = await res.text();
      if (text.length > cap) {
        text = text.slice(0, cap);
        truncated = true;
      }
    }
    return { status: res.status, body: text, truncated };
  } catch (err) {
    if (ac.signal.aborted) {
      const reason = ac.signal.reason as Error | undefined;
      throw new Error(`http: ${req.method} ${req.url} aborted — ${reason?.message ?? 'aborted'}`);
    }
    throw new Error(`http: ${req.method} ${req.url} failed — ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Success unless `expectStatus` lists codes, in which case only those. */
export function statusOk(status: number, expect?: readonly number[]): boolean {
  if (expect && expect.length > 0) return expect.includes(status);
  return status >= 200 && status < 300;
}

/** Validate an `http` body; returns problems (empty = valid). */
export function validateHttpBody(h: unknown): string[] {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return ['http must be an object with a `url`'];
  const b = h as Record<string, unknown>;
  const out: string[] = [];
  const known = ['url', 'method', 'headers', 'body', 'allowHosts', 'expectStatus', 'timeoutSeconds', 'maxResponseBytes', 'auth', 'files'];
  for (const k of Object.keys(b)) if (!known.includes(k)) out.push(`http.${k} is not a known option`);
  if (typeof b.url !== 'string' || b.url.trim() === '') out.push('http.url is required');
  if (b.method !== undefined && !(HTTP_METHODS as readonly unknown[]).includes(b.method)) {
    out.push(`http.method must be one of ${HTTP_METHODS.join(' / ')}`);
  }
  if (
    b.headers !== undefined &&
    (!b.headers ||
      typeof b.headers !== 'object' ||
      Array.isArray(b.headers) ||
      Object.values(b.headers).some(v => typeof v !== 'string'))
  ) {
    out.push('http.headers must be an object of string values');
  }
  if (
    b.allowHosts !== undefined &&
    (!Array.isArray(b.allowHosts) || b.allowHosts.some(x => typeof x !== 'string' || !x.trim()))
  ) {
    out.push('http.allowHosts must be a list of hostnames');
  }
  if (
    b.expectStatus !== undefined &&
    (!Array.isArray(b.expectStatus) ||
      b.expectStatus.some(x => typeof x !== 'number' || !Number.isInteger(x) || x < 100 || x > 599))
  ) {
    out.push('http.expectStatus must be a list of HTTP status codes');
  }
  for (const k of ['timeoutSeconds', 'maxResponseBytes'] as const) {
    const v = b[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
      out.push(`http.${k} must be a positive number`);
    }
  }
  if (b.auth !== undefined) {
    const a = b.auth as { basic?: { username?: unknown; password?: unknown } } | null;
    const ok =
      !!a &&
      typeof a === 'object' &&
      Object.keys(a).length === 1 &&
      !!a.basic &&
      typeof a.basic.username === 'string' &&
      typeof a.basic.password === 'string';
    if (!ok) out.push('http.auth must be { basic: { username, password } } (strings)');
  }
  if (b.files !== undefined) {
    if (!Array.isArray(b.files) || b.files.length === 0) {
      out.push('http.files must be a non-empty list');
    } else {
      b.files.forEach((f, i) => {
        const x = f as Record<string, unknown>;
        if (!x || typeof x.artifact !== 'string' || x.artifact === '') {
          out.push(`http.files[${i}].artifact is required`);
        }
        for (const k of ['field', 'filename'] as const) {
          if (x?.[k] !== undefined && (typeof x[k] !== 'string' || x[k] === '')) {
            out.push(`http.files[${i}].${k} must be a non-empty string`);
          }
        }
      });
      if (typeof b.body === 'string') out.push('http.body must be an object when files are sent');
      if (b.method === undefined || b.method === 'GET') out.push('http.files needs a POST / PUT / PATCH method');
    }
  }
  if (b.body !== undefined && b.method === 'GET') {
    out.push('http.body is ignored on a GET request');
  }
  return out;
}
