import { collectAllPhases } from './graph-serialize';
import type { Node } from './types';

/** Built-in tools any agent phase of `orchestration` declares (`tools: [...]`), first-seen order. Agents only
 *  get them when "Expose declared tools to agents" is on (Settings → Agent tools); otherwise they run without
 *  them, so the Run dialog warns. */
export function declaredAgentTools(orchestration: Node | null | undefined): string[] {
  if (!orchestration) return [];
  const all = new Map<string, Node>();
  collectAllPhases(orchestration, all);
  const out: string[] = [];
  for (const node of [orchestration, ...all.values()]) {
    for (const tool of node.tools ?? []) if (!out.includes(tool)) out.push(tool);
  }
  return out;
}
