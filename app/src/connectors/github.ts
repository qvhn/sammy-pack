/**
 * GitHub connector (v1, read-only).
 *
 * Uses a Personal Access Token stored in localStorage to fetch repository
 * contents directly from the GitHub REST API (CORS-supported endpoint).
 *
 * v1 scope: read orchestrations + agents from a configured workspace.
 * Write-back (PUT contents with SHA + commit) is the next iteration.
 */

import type { AgentFile } from '../api';
import type { Node, Workspace } from '../types';

const GITHUB_API = 'https://api.github.com';

type GhEntry = { name: string; path: string; type: 'file' | 'dir'; sha: string };
type GhFile = { name: string; path: string; sha: string; encoding: string; content?: string };

async function ghFetch<T>(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const hasBody = init?.body !== undefined;
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(init!.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 280)}`);
  }
  // DELETE can return 200 with body or 204 with none.
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

function base64Encode(s: string): string {
  // UTF-8 safe encode for btoa.
  return btoa(unescape(encodeURIComponent(s)));
}

function ownerRepo(ws: Workspace): { owner: string; repo: string } {
  const r = (ws.repo ?? '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [owner, repo] = r.split('/');
  if (!owner || !repo) throw new Error(`Invalid GitHub repo: ${ws.repo}`);
  return { owner, repo };
}

function base64Decode(content: string): string {
  // GitHub returns base64 with line breaks.
  const clean = content.replace(/\s+/g, '');
  try {
    return decodeURIComponent(escape(atob(clean)));
  } catch {
    return atob(clean);
  }
}

async function listDir(
  ws: Workspace,
  token: string,
  path: string,
): Promise<GhEntry[]> {
  const { owner, repo } = ownerRepo(ws);
  const ref = ws.ref ?? 'main';
  const data = await ghFetch<GhEntry[] | GhEntry>(
    `/repos/${owner}/${repo}/contents/${path.replace(/^\//, '').replace(/\/$/, '')}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (!Array.isArray(data)) {
    throw new Error(`Expected directory listing for ${path}`);
  }
  return data;
}

async function readFile(
  ws: Workspace,
  token: string,
  path: string,
): Promise<string> {
  const { owner, repo } = ownerRepo(ws);
  const ref = ws.ref ?? 'main';
  const data = await ghFetch<GhFile>(
    `/repos/${owner}/${repo}/contents/${path.replace(/^\//, '')}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (data.encoding !== 'base64' || !data.content) {
    throw new Error(`Unexpected content encoding for ${path}`);
  }
  return base64Decode(data.content);
}

export async function listRemoteOrchestrations(
  ws: Workspace,
  token: string,
): Promise<Node[]> {
  const dir = (ws.paths?.orchestrations ?? 'examples').replace(/\/$/, '');
  const entries = await listDir(ws, token, dir);
  const out: Node[] = [];
  for (const e of entries) {
    if (e.type !== 'file' || !e.name.endsWith('.json')) continue;
    try {
      const raw = await readFile(ws, token, e.path);
      out.push(JSON.parse(raw));
    } catch (err) {
      console.warn(`[github] skip ${e.path}:`, err);
    }
  }
  return out;
}

async function getFileSha(
  ws: Workspace,
  token: string,
  path: string,
): Promise<string | null> {
  const { owner, repo } = ownerRepo(ws);
  const ref = ws.ref ?? 'main';
  try {
    const data = await ghFetch<GhFile>(
      `/repos/${owner}/${repo}/contents/${path.replace(/^\//, '')}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    return data.sha;
  } catch (err) {
    if ((err as Error).message.includes('404')) return null;
    throw err;
  }
}

/**
 * Create or update a file in the remote repo. Uses the SHA round-trip if the
 * file already exists. Commits to `workspace.ref` (or `main`).
 */
export async function writeRemoteOrchestration(
  ws: Workspace,
  token: string,
  node: Node,
): Promise<void> {
  const { owner, repo } = ownerRepo(ws);
  const branch = ws.ref ?? 'main';
  const dir = (ws.paths?.orchestrations ?? 'examples').replace(/\/$/, '');
  const filePath = `${dir}/${node.name}.json`;
  const sha = await getFileSha(ws, token, filePath);
  const content = base64Encode(JSON.stringify(node, null, 2) + '\n');
  await ghFetch(`/repos/${owner}/${repo}/contents/${filePath}`, token, {
    method: 'PUT',
    body: {
      message: `sammy-pack: ${sha ? 'update' : 'create'} ${node.name}`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    },
  });
}

export async function deleteRemoteOrchestration(
  ws: Workspace,
  token: string,
  name: string,
): Promise<void> {
  const { owner, repo } = ownerRepo(ws);
  const branch = ws.ref ?? 'main';
  const dir = (ws.paths?.orchestrations ?? 'examples').replace(/\/$/, '');
  const filePath = `${dir}/${name}.json`;
  const sha = await getFileSha(ws, token, filePath);
  if (!sha) return; // already gone
  await ghFetch(`/repos/${owner}/${repo}/contents/${filePath}`, token, {
    method: 'DELETE',
    body: {
      message: `sammy-pack: delete ${name}`,
      sha,
      branch,
    },
  });
}

export async function listRemoteAgents(
  ws: Workspace,
  token: string,
): Promise<AgentFile[]> {
  const dir = (ws.paths?.agents ?? 'agents').replace(/\/$/, '');
  const entries = await listDir(ws, token, dir);
  const out: AgentFile[] = [];
  for (const e of entries) {
    if (e.type !== 'file' || !e.name.endsWith('.md')) continue;
    if (e.name.toLowerCase() === 'readme.md') continue;
    try {
      const raw = await readFile(ws, token, e.path);
      out.push({ name: e.name.replace(/\.md$/, ''), raw });
    } catch (err) {
      console.warn(`[github] skip ${e.path}:`, err);
    }
  }
  return out;
}
