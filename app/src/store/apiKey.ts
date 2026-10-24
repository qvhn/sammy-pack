const KEY = 'sammy.anthropicApiKey';
const MODEL_KEY = 'sammy.anthropicModel';
const AUTH_MODE_KEY = 'sammy.authMode';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Which credential path the executor uses to make LLM calls.
 *  - `direct-api-key`: browser → api.anthropic.com with x-api-key (the
 *    legacy path; needs a key in Settings).
 *  - `claude-code-proxy`: browser → dev-server /api/llm/stream → Claude
 *    Agent SDK using the user's `claude` CLI login. No API key needed;
 *    calls draw from the user's Claude plan SDK credit pool. */
export type AuthMode = 'direct-api-key' | 'claude-code-proxy';

const DEFAULT_AUTH_MODE: AuthMode = 'direct-api-key';

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(KEY, key.trim());
    else localStorage.removeItem(KEY);
  } catch {
    /* localStorage unavailable */
  }
}

export function getModel(): string {
  try {
    return localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function setModel(model: string): void {
  try {
    if (model.trim()) localStorage.setItem(MODEL_KEY, model.trim());
    else localStorage.removeItem(MODEL_KEY);
  } catch {
    /* */
  }
}

export function getAuthMode(): AuthMode {
  try {
    const v = localStorage.getItem(AUTH_MODE_KEY);
    return v === 'claude-code-proxy' ? 'claude-code-proxy' : DEFAULT_AUTH_MODE;
  } catch {
    return DEFAULT_AUTH_MODE;
  }
}

export function setAuthMode(mode: AuthMode): void {
  try {
    localStorage.setItem(AUTH_MODE_KEY, mode);
  } catch {
    /* localStorage unavailable */
  }
}

const ALLOW_TOOLS_KEY = 'sammy.allowAgentTools';

/** When true, agents that declare `tools: [...]` get those tools
 *  exposed to the LLM (via the Claude Code proxy only — direct API
 *  mode is text-only). Off by default for safety: agents-with-tools
 *  can run shell commands, edit files, etc. on the user's machine. */
export function getAllowAgentTools(): boolean {
  try {
    return localStorage.getItem(ALLOW_TOOLS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAllowAgentTools(enabled: boolean): void {
  try {
    localStorage.setItem(ALLOW_TOOLS_KEY, enabled ? 'true' : 'false');
  } catch {
    /* */
  }
}

// Per-provider API keys for the multi-provider routing layer.
// A node with `provider: "openai"` (or "gemini") routes through that
// provider's adapter at run time, using the key stored here.
const OPENAI_KEY = 'sammy.openaiApiKey';
const GEMINI_KEY = 'sammy.geminiApiKey';

function readLs(k: string): string {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}
function writeLs(k: string, v: string): void {
  try {
    if (v.trim()) localStorage.setItem(k, v.trim());
    else localStorage.removeItem(k);
  } catch {
    /* */
  }
}

export function getOpenAiKey(): string {
  return readLs(OPENAI_KEY);
}
export function setOpenAiKey(key: string): void {
  writeLs(OPENAI_KEY, key);
}
export function getGeminiKey(): string {
  return readLs(GEMINI_KEY);
}
export function setGeminiKey(key: string): void {
  writeLs(GEMINI_KEY, key);
}

/** Snapshot of every per-provider key — handed to `buildProviderRegistry`
 *  at run start so the executor can route per-node providers. */
export function getProviderKeys(): {
  openai: string;
  gemini: string;
  anthropic: string;
} {
  return {
    openai: getOpenAiKey(),
    gemini: getGeminiKey(),
    // The legacy `sammy.anthropicApiKey` doubles as the per-provider
    // Anthropic key — a node with `provider: "anthropic"` routes
    // through the direct-API path with this key.
    anthropic: getApiKey() ?? '',
  };
}

export { DEFAULT_AUTH_MODE, DEFAULT_MODEL };
