import type { Workspace } from '../types';

const KEY = 'sammy.activeWorkspace';

/**
 * The active workspace determines where listOrchestrations / listAgents read
 * from. `null` means the local dev workspace (Vite middleware → repo files).
 * A non-null value points at a remote workspace served through a connector.
 */
export function getActiveWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Workspace;
  } catch {
    return null;
  }
}

export function setActiveWorkspace(ws: Workspace | null): void {
  try {
    if (ws) localStorage.setItem(KEY, JSON.stringify(ws));
    else localStorage.removeItem(KEY);
  } catch {
    /* */
  }
}

export function isRemoteActive(): boolean {
  const ws = getActiveWorkspace();
  return !!ws && ws.connection !== 'local';
}
