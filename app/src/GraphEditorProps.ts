import type { Node } from './types';
import type { NodeRunStatus } from './lib/runStatus';

/** Shared prop contract for the Graph editor. Both the web implementation
 *  (GraphEditor.web.tsx) and the native stub (GraphEditor.tsx) import this so
 *  the two can't drift — previously the stub declared a narrower `{ orchestration,
 *  onChange }` and every new prop added to the web editor produced a type error
 *  at the call site (which resolves to the stub under tsc). */
export type GraphEditorProps = {
  orchestration: Node;
  onChange: (next: Node) => void;
  /** Names of every orchestration the workspace knows about (subflow picker). */
  availableOrchestrations?: string[];
  /** Lifted selection so it persists across Pipeline → Graph → Tree switches. */
  selectedNodeName?: string | null;
  onSelectionChange?: (name: string | null) => void;
  /** Names with hard validation errors → red border + ⚠ badge. */
  errorNodeNames?: Set<string>;
  errorMessageByNode?: Map<string, string>;
  /** Live run status per node name (pending/running/done/error/skipped). */
  runStatusByNode?: Map<string, NodeRunStatus>;
  /** The leaf phase currently executing — edges into it animate. */
  liveActivePhase?: string | null;
};
