export type ConnectionType =
  | 'github'
  | 'bitbucket'
  | 'gitlab'
  | 'jira'
  | 'linear'
  | 'figma'
  | 'notion'
  | 'slack';

function tokenKey(type: ConnectionType): string {
  return `sammy.connection.${type}.token`;
}
function extraKey(type: ConnectionType, field: string): string {
  return `sammy.connection.${type}.${field}`;
}

// localStorage may be undefined when this module loads server-side
// (jest / node). Guard each access.
function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function getConnectionToken(type: ConnectionType): string | null {
  return ls()?.getItem(tokenKey(type)) ?? null;
}

export function setConnectionToken(type: ConnectionType, token: string): void {
  const store = ls();
  if (!store) return;
  if (token.trim()) store.setItem(tokenKey(type), token.trim());
  else store.removeItem(tokenKey(type));
}

/** Optional per-provider field — e.g. Jira's site URL, Slack's team
 *  id. Stored alongside the token under sammy.connection.<type>.<field>. */
export function getConnectionField(type: ConnectionType, field: string): string | null {
  return ls()?.getItem(extraKey(type, field)) ?? null;
}
export function setConnectionField(
  type: ConnectionType,
  field: string,
  value: string,
): void {
  const store = ls();
  if (!store) return;
  if (value.trim()) store.setItem(extraKey(type, field), value.trim());
  else store.removeItem(extraKey(type, field));
}

export function hasConnection(type: ConnectionType): boolean {
  return !!getConnectionToken(type);
}
