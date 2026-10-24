/**
 * Sandbox policy: resolve + enforce a node's execution-safety rules.
 *
 * The hazard this exists for: a non-engineer drags a shell-tool agent
 * into the visual editor and clicks Run. Real OS-level isolation
 * (containers / microVMs) is a separate, bigger effort — this module is
 * the policy layer that runs BEFORE the SDK call:
 *
 *   - caps which Claude Code tools an agent may use (allowlist)
 *   - strips network tools when networkAccess is off
 *   - denies dangerous Bash commands by substring (checked at the
 *     tool-call boundary inside the SDK stream)
 *   - pins the SDK permission mode to the stricter of the node's own
 *     setting and the sandbox floor
 *
 * Policies COMPOSE by tightening only. A node's effective sandbox is
 * its own merged with every ancestor's: allowlists intersect, denylists
 * union, the stricter permissionMode wins. A child can never widen what
 * an ancestor restricted.
 */

import type { Sandbox } from '../types';

/** Permission modes ordered loosest → strictest. Used to pick the
 *  stricter of two when sandboxes merge. */
const PERMISSION_RANK: Record<string, number> = {
  bypassPermissions: 0,
  default: 1,
  acceptEdits: 2,
  plan: 3,
};

/** Network-capable Claude Code tools — stripped when networkAccess
 *  is false. */
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

/** Merge a child sandbox onto a parent's — the result is never wider
 *  than either input. Pass the outermost (run-root) sandbox first and
 *  fold inward, or call repeatedly while walking down the tree. */
export function mergeSandbox(
  parent: Sandbox | undefined,
  child: Sandbox | undefined,
): Sandbox | undefined {
  if (!parent) return child;
  if (!child) return parent;
  const merged: Sandbox = {};

  // allowedTools: intersect. If only one side caps, that cap applies.
  if (parent.allowedTools && child.allowedTools) {
    const childSet = new Set(child.allowedTools);
    merged.allowedTools = parent.allowedTools.filter(t => childSet.has(t));
  } else {
    merged.allowedTools = parent.allowedTools ?? child.allowedTools;
  }

  // deniedCommands: union.
  const denies = [
    ...(parent.deniedCommands ?? []),
    ...(child.deniedCommands ?? []),
  ];
  if (denies.length > 0) merged.deniedCommands = [...new Set(denies)];

  // networkAccess: false wins (more restrictive). Undefined = inherit.
  if (parent.networkAccess === false || child.networkAccess === false) {
    merged.networkAccess = false;
  } else if (
    parent.networkAccess !== undefined ||
    child.networkAccess !== undefined
  ) {
    merged.networkAccess = true;
  }

  // permissionMode: stricter wins.
  const pm = [parent.permissionMode, child.permissionMode].filter(
    (m): m is NonNullable<Sandbox['permissionMode']> => m !== undefined,
  );
  if (pm.length > 0) {
    merged.permissionMode = pm.reduce((a, b) =>
      PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b,
    );
  }

  // code-node caps: stricter (smaller) wins.
  const secs = [parent.maxRunSeconds, child.maxRunSeconds].filter(
    (n): n is number => typeof n === 'number',
  );
  if (secs.length > 0) merged.maxRunSeconds = Math.min(...secs);
  const bytes = [parent.maxOutputBytes, child.maxOutputBytes].filter(
    (n): n is number => typeof n === 'number',
  );
  if (bytes.length > 0) merged.maxOutputBytes = Math.min(...bytes);
  const fan = [parent.maxFanout, child.maxFanout].filter(
    (n): n is number => typeof n === 'number',
  );
  if (fan.length > 0) merged.maxFanout = Math.min(...fan);

  return merged;
}

export type ToolPolicyResult = {
  /** The tool list the agent is actually allowed to use, after the
   *  allowlist intersection + network strip. */
  effectiveTools: string[];
  /** Tools the agent declared but the sandbox removed — surfaced to
   *  the user so a stripped capability isn't a silent surprise. */
  strippedTools: string[];
};

/** Apply a sandbox's tool rules to an agent's declared tool list.
 *  `declaredTools` should already be the Claude-Code-builtin subset
 *  (PascalCase names), not connector ids. */
export function applyToolPolicy(
  declaredTools: string[],
  sandbox: Sandbox | undefined,
): ToolPolicyResult {
  if (!sandbox) {
    return { effectiveTools: [...declaredTools], strippedTools: [] };
  }
  const allow = sandbox.allowedTools
    ? new Set(sandbox.allowedTools)
    : null;
  const networkOff = sandbox.networkAccess === false;
  const effective: string[] = [];
  const stripped: string[] = [];
  for (const tool of declaredTools) {
    if (allow && !allow.has(tool)) {
      stripped.push(tool);
      continue;
    }
    if (networkOff && NETWORK_TOOLS.has(tool)) {
      stripped.push(tool);
      continue;
    }
    effective.push(tool);
  }
  return { effectiveTools: effective, strippedTools: stripped };
}

/** Resolve the SDK permission mode for a node: the stricter of the
 *  node's own permissionMode and the sandbox floor. Returns undefined
 *  when neither is set (caller falls back to its own default). */
export function resolvePermissionMode(
  nodeMode: Sandbox['permissionMode'] | undefined,
  sandbox: Sandbox | undefined,
): Sandbox['permissionMode'] | undefined {
  const candidates = [nodeMode, sandbox?.permissionMode].filter(
    (m): m is NonNullable<Sandbox['permissionMode']> => m !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) =>
    PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b,
  );
}

/** Check a Bash command against the sandbox's denylist. Returns the
 *  matched denylist entry when the command is blocked, or null when
 *  it's allowed. Case-insensitive substring match — deliberately
 *  blunt; this is a blast-radius backstop, not a full shell parser. */
export function checkDeniedCommand(
  command: string,
  sandbox: Sandbox | undefined,
): string | null {
  if (!sandbox?.deniedCommands || sandbox.deniedCommands.length === 0) {
    return null;
  }
  const haystack = command.toLowerCase();
  for (const needle of sandbox.deniedCommands) {
    if (haystack.includes(needle.toLowerCase())) return needle;
  }
  return null;
}
