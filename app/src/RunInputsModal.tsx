import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { cloneRepoUrl, locateRepo } from './api';
import { type ExecutionMode, type HarnessFollow, type Node } from './types';
import { declaredAgentTools } from './declaredTools';
import { getAllowAgentTools } from './store/apiKey';
import { FOLLOW_HELP, getHarnessSettings } from './store/harness';
import { followLabel, HARNESS_FOLLOWS } from './llm/harness';
import type { RunModeOptions } from './store/runs';

const FOLLOW_RANK: Record<HarnessFollow, number> = { advisory: 0, loose: 1, strict: 2 };

export type RunInputFile = { filename: string; mediaType: string; data: string };
export type RunInputValues = Record<
  string,
  { value?: string; file?: RunInputFile }
>;

/** Read a browser File → base64 RunInputFile (binary-safe, for PDF/docx/etc.).
 *  Shared by the click-to-pick and drag-and-drop paths. Null on read error. */
function readFileToRunInput(file: File): Promise<RunInputFile | null> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      // strip the "data:<mime>;base64," prefix
      const data = result.includes(',')
        ? result.slice(result.indexOf(',') + 1)
        : result;
      resolve({
        filename: file.name,
        mediaType: file.type || 'application/octet-stream',
        data,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** Web file picker → base64. Null if the user cancels or the read fails.
 *  The hidden input is APPENDED TO THE DOM before .click() — Safari/WebKit
 *  refuses to open the dialog for a detached input element (the bug behind
 *  "File/Doc doesn't let me choose"). A focus fallback cleans up on cancel. */
function pickRunFile(): Promise<RunInputFile | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      cleanup();
      resolve(file ? await readFileToRunInput(file) : null);
    };
    // No reliable "cancel" event — when the dialog closes the window regains
    // focus; sweep up the detached input shortly after if onchange never fired.
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(cleanup, 400);
    };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

/** Placeholder for a declared text-like run input. Typed kinds get a hint
 *  of the expected shape; a plain `text` input names what it wants (its
 *  description, else its name) rather than the bare word "text". */
export function runInputPlaceholder(d: {
  name: string;
  kind: string;
  description?: string;
}): string {
  switch (d.kind) {
    case 'jira':
      return 'A Jira key or link, a GitHub issue link, or describe the work';
    case 'confluence':
      return 'Confluence page URL or id';
    case 'github':
      return 'GitHub issue / PR URL';
    case 'url':
      return 'https://…';
    default: {
      // The description's first clause only — the whole description already
      // shows in the label above, and a paragraph does not fit a field.
      const first = d.description?.split(/(?<=[.:;])\s/)[0]?.replace(/[.:;]$/, '').trim();
      if (!first) return d.name;
      return first.length > 70 ? `${first.slice(0, 69)}…` : first;
    }
  }
}

/**
 * The pre-run input modal. ALWAYS shown when a run is launched (the editor's
 * ▶ Run and the Runs page replay both open it), even when the orchestration
 * declares no `inputs`.
 *
 *  - Declared `inputs` (per `InputDecl`) render as typed fields ABOVE the
 *    instructions box — a ticket / doc / URL / freeform string, resolved
 *    server-side into `${name}` before phase 1. `text` / `url` / `jira` /
 *    `confluence` / `github` are text fields; `file` is an upload (base64).
 *    Required (*) declared inputs are validated before Run is enabled.
 *  - An OPTIONAL multiline "Additional instructions" textarea is ALWAYS
 *    rendered (even with zero declared inputs). Its text is returned as the
 *    run's INITIAL INPUT (`state.input` / `${input}` before phase 1).
 *
 * So: no declared inputs → just the optional instructions box + ▶ Run;
 * declared inputs → typed fields + the optional instructions box + ▶ Run.
 *
 * `defaultInstructions` pre-fills the instructions box (used by replay to
 * carry the prior run's initial input forward). Renders nothing only when no
 * orchestration is selected.
 */
export function RunInputsModal({
  orchestration,
  onClose,
  onRun,
  defaultInstructions,
  error,
}: {
  orchestration: Node | null;
  onClose: () => void;
  /** `mode` carries the dialog's Pipeline / Harness choice and, for a
   *  harness the user changed, the strictness — absent fields mean "as the
   *  orchestration (or Settings) says". */
  onRun: (values: RunInputValues, instructions: string, mode: RunModeOptions) => void;
  defaultInstructions?: string;
  /** Why the last ▶ Run from this dialog didn't start (the dialog stays open to say so). */
  error?: string | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, RunInputFile>>({});
  const [instructions, setInstructions] = useState('');
  // A repository URL typed into an input that feeds a `worktrees` entry:
  // the clone offer shown when this machine has no clone of it.
  const [cloneOffer, setCloneOffer] = useState<{
    url: string;
    cloneTo: string | null;
    busy: boolean;
    error?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  // The "provide every required input" hint waits until the user has tried
  // to run (or left a required field empty) — not shouted on open.
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Pipeline or harness, and the harness's strictness. `follow` stays null
  // until the user picks one, so an untouched dialog leaves the decision to
  // the orchestration / Settings (and the run records that as its source).
  const [execution, setExecution] = useState<ExecutionMode>('pipeline');
  const [follow, setFollow] = useState<HarnessFollow | null>(null);
  const [workspaceFollow, setWorkspaceFollow] = useState<HarnessFollow | null>(null);
  // First text field — focused when the dialog opens so the user can type
  // straight away (falls back to the instructions box).
  const firstFieldRef = useRef<TextInput | null>(null);
  const instructionsRef = useRef<TextInput | null>(null);
  useEffect(() => {
    setValues({});
    setFiles({});
    setCloneOffer(null);
    setChecking(false);
    setAttempted(false);
    setTouched({});
    setInstructions(defaultInstructions ?? '');
    setExecution(orchestration?.execution ?? 'pipeline');
    setFollow(null);
    // Re-seed when a different orchestration / default is loaded into the modal.
  }, [orchestration, defaultInstructions]);

  useEffect(() => {
    if (!orchestration) return;
    let live = true;
    getHarnessSettings()
      .then(s => live && setWorkspaceFollow(s.follow))
      .catch(() => live && setWorkspaceFollow(null));
    return () => {
      live = false;
    };
  }, [orchestration]);

  useEffect(() => {
    if (!orchestration) return;
    (firstFieldRef.current ?? instructionsRef.current)?.focus?.();
  }, [orchestration]);

  // Escape closes the dialog (web). Not while a clone is in flight — that
  // request would keep running behind a closed dialog.
  const cloneBusy = !!cloneOffer?.busy;
  useEffect(() => {
    if (!orchestration || cloneBusy) return;
    const g = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: { key?: string }) => void) => void;
      removeEventListener?: (t: string, fn: (e: { key?: string }) => void) => void;
    };
    if (!g.addEventListener || !g.removeEventListener) return;
    const onKey = (e: { key?: string }) => {
      if (e.key === 'Escape') onClose();
    };
    g.addEventListener('keydown', onKey);
    return () => g.removeEventListener?.('keydown', onKey);
  }, [orchestration, cloneBusy, onClose]);

  // The modal ALWAYS opens for a selected orchestration — even with zero
  // declared inputs, the optional instructions box still renders.
  if (!orchestration) return null;
  const decls = orchestration.inputs ?? [];

  const provided = (d: { name: string; kind: string }): boolean =>
    d.kind === 'file' ? !!files[d.name] : !!(values[d.name] ?? '').trim();
  const missingRequired = decls.some(d => d.required && !provided(d));
  const showMissing =
    missingRequired &&
    (attempted || decls.some(d => d.required && touched[d.name] && !provided(d)));
  const firstTextName = decls.find(d => d.kind !== 'file')?.name;


  // Inputs a `worktrees` entry reads as its repo (`${name}` / `${input.name}`)
  // need a LOCAL path; a pasted web address is swapped for this machine's
  // clone of it, or the dialog offers to make one.
  const repoInputs = new Set(
    decls
      .filter(d =>
        (orchestration.worktrees ?? []).some(
          w => w.repo.includes(`\${${d.name}}`) || w.repo.includes(`\${input.${d.name}}`),
        ),
      )
      .map(d => d.name),
  );
  const isRepoUrl = (v: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w.-]+@[\w.-]+:/.test(v);

  const collect = (overrides: Record<string, string>): RunInputValues => {
    const out: RunInputValues = {};
    for (const d of decls) {
      if (d.kind === 'file') {
        if (files[d.name]) out[d.name] = { file: files[d.name] };
      } else {
        const v = (overrides[d.name] ?? values[d.name] ?? '').trim();
        if (v) out[d.name] = { value: v };
      }
    }
    return out;
  };

  const submit = async () => {
    const overrides: Record<string, string> = {};
    const urls = [...repoInputs]
      .map(name => ({ name, value: (values[name] ?? '').trim() }))
      .filter(r => isRepoUrl(r.value));
    if (urls.length > 0) {
      setChecking(true);
      try {
        for (const r of urls) {
          const loc = await locateRepo(r.value);
          if (!loc.local) {
            setCloneOffer({ url: r.value, cloneTo: loc.cloneTo, busy: false });
            return;
          }
          overrides[r.name] = loc.local;
        }
      } catch (err) {
        setCloneOffer({ url: urls[0].value, cloneTo: null, busy: false, error: (err as Error).message });
        return;
      } finally {
        setChecking(false);
      }
    }
    setValues(v => ({ ...v, ...overrides }));
    // The instructions box maps to the run's initial input. Trim to keep an
    // empty box equivalent to "no initial input" (same as a plain ▶ Run).
    onRun(collect(overrides), instructions.trim(), {
      ...(execution !== (orchestration.execution ?? 'pipeline') ? { execution } : {}),
      ...(execution === 'harness' && follow ? { follow } : {}),
    });
  };

  // Run if the form is valid; otherwise surface the missing-input hint.
  const trySubmit = () => {
    if (checking || cloneOffer) return;
    if (missingRequired) {
      setAttempted(true);
      return;
    }
    submit();
  };

  const acceptClone = async () => {
    if (!cloneOffer) return;
    setCloneOffer({ ...cloneOffer, busy: true, error: undefined });
    try {
      await cloneRepoUrl(cloneOffer.url);
      setCloneOffer(null);
      await submit();
    } catch (err) {
      setCloneOffer({ ...cloneOffer, busy: false, error: (err as Error).message });
    }
  };

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} />
      <View style={styles.modalPanel}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            ▶ Run "{orchestration.name}"
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.modalClose}>×</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
          {decls.map(d => (
            <View key={d.name} style={styles.field}>
              <Text style={styles.label}>
                {d.name}
                {d.required ? ' *' : ''} · {d.kind}
                {d.description ? ` — ${d.description}` : ''}
              </Text>
              {d.kind === 'file' ? (
                <FileDropField
                  name={d.name}
                  file={files[d.name]}
                  onFile={f => setFiles(s => ({ ...s, [d.name]: f }))}
                />
              ) : (
                <TextInput
                  ref={d.name === firstTextName ? firstFieldRef : undefined}
                  value={values[d.name] ?? ''}
                  onChangeText={t => setValues(s => ({ ...s, [d.name]: t }))}
                  onBlur={() => setTouched(s => ({ ...s, [d.name]: true }))}
                  // Enter in a single-line field runs (when the form is valid).
                  onSubmitEditing={trySubmit}
                  returnKeyType="go"
                  placeholder={runInputPlaceholder(d)}
                  style={styles.input}
                  autoCapitalize="none"
                />
              )}
            </View>
          ))}
          <RunModePicker
            orchestration={orchestration}
            execution={execution}
            onExecution={setExecution}
            follow={follow}
            onFollow={setFollow}
            workspaceFollow={workspaceFollow}
          />
          {/* ALWAYS rendered — the optional initial-input box. Maps to the
              run's `state.input` (`${input}`). Never required, even when
              declared inputs above are. */}
          <View style={styles.field}>
            <Text style={styles.label}>Additional instructions (optional)</Text>
            <TextInput
              ref={instructionsRef}
              value={instructions}
              onChangeText={setInstructions}
              placeholder={'e.g. look at ticket-123 and do xyz'}
              style={[styles.input, styles.instructionsInput]}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>
        </ScrollView>
        {showMissing ? (
          <Text style={styles.errorText}>Provide every required (*) input to run.</Text>
        ) : null}
        {(() => {
          const tools = declaredAgentTools(orchestration);
          return tools.length > 0 && !getAllowAgentTools() ? (
            <Text style={styles.errorText}>
              {`Agents in this pipeline declare tools (${tools.join(', ')}), but "Expose declared tools to agents" is off in Settings → Agent tools, so they will run without them.`}
            </Text>
          ) : null;
        })()}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {cloneOffer ? (
          <View style={styles.cloneOffer}>
            <Text style={styles.cloneOfferText}>
              {cloneOffer.cloneTo
                ? `No local clone of ${cloneOffer.url}. Clone it to ${cloneOffer.cloneTo} and run?`
                : `No local clone of ${cloneOffer.url}.`}
            </Text>
            {cloneOffer.error ? (
              <Text style={styles.errorText}>{cloneOffer.error}</Text>
            ) : null}
            <View style={styles.cloneOfferButtons}>
              <Pressable
                onPress={() => setCloneOffer(null)}
                disabled={cloneOffer.busy}
                style={[styles.button, styles.secondaryButton]}
                accessibilityRole="button"
                accessibilityLabel="Don't clone">
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              {cloneOffer.cloneTo ? (
                <Pressable
                  onPress={() => void acceptClone()}
                  disabled={cloneOffer.busy}
                  style={[styles.button, styles.primaryButton, cloneOffer.busy && styles.buttonDisabled]}
                  accessibilityRole="button"
                  accessibilityLabel="Clone and run">
                  <Text style={styles.primaryButtonText}>
                    {cloneOffer.busy ? 'Cloning…' : 'Clone and run'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : (
          <View style={styles.modalButtonRow}>
            <Pressable
              // Stays pressable while inputs are missing so a press can
              // reveal WHY it won't run; it just looks (and acts) inert.
              onPress={trySubmit}
              disabled={checking}
              accessibilityState={{ disabled: missingRequired || checking }}
              style={[
                styles.button,
                styles.primaryButton,
                (missingRequired || checking) && styles.buttonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Run with inputs">
              <Text style={styles.primaryButtonText}>{checking ? 'Checking…' : '▶ Run'}</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

/** "How to run": Pipeline or Harness, and for a harness how strictly it
 *  follows the steps. Shows where the default comes from, and a locked
 *  orchestration's floor (only stricter choices are offered). */
function RunModePicker({
  orchestration,
  execution,
  onExecution,
  follow,
  onFollow,
  workspaceFollow,
}: {
  orchestration: Node;
  execution: ExecutionMode;
  onExecution: (e: ExecutionMode) => void;
  follow: HarnessFollow | null;
  onFollow: (f: HarnessFollow) => void;
  workspaceFollow: HarnessFollow | null;
}) {
  const declared = orchestration.harness?.follow;
  const locked = orchestration.harness?.lockFollow === true;
  const floor: HarnessFollow = declared ?? 'strict';
  const fallback: { value: HarnessFollow; from: string } = declared
    ? { value: declared, from: 'this orchestration' }
    : workspaceFollow
      ? { value: workspaceFollow, from: 'Settings' }
      : { value: 'strict', from: 'the default' };
  const effective = follow ?? fallback.value;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>How to run</Text>
      <View style={styles.pillRow} accessibilityRole="radiogroup" accessibilityLabel="How to run">
        {(['pipeline', 'harness'] as const).map(m => (
          <Pressable
            key={m}
            onPress={() => onExecution(m)}
            style={[styles.pill, execution === m && styles.pillOn]}
            accessibilityRole="radio"
            accessibilityState={{ checked: execution === m }}
            accessibilityLabel={m === 'pipeline' ? 'Pipeline' : 'Harness'}>
            <Text style={[styles.pillText, execution === m && styles.pillTextOn]}>
              {m === 'pipeline' ? 'Pipeline' : 'Harness'}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.hint}>
        {execution === 'pipeline'
          ? 'Each agent step gets its own agent; the engine walks the steps.'
          : 'One agent follows the steps and does each itself — with the skill a step names, if any. Script, HTTP and wait steps still run exactly as written, and gates still stop for approval.'}
      </Text>
      {execution === 'harness' ? (
        <>
          <Text style={[styles.label, styles.subLabel]}>How strictly</Text>
          <View style={styles.pillRow} accessibilityRole="radiogroup" accessibilityLabel="How strictly">
            {HARNESS_FOLLOWS.map(f => {
              const tooLoose = locked && FOLLOW_RANK[f] < FOLLOW_RANK[floor];
              const on = effective === f;
              return (
                <Pressable
                  key={f}
                  onPress={() => !tooLoose && onFollow(f)}
                  disabled={tooLoose}
                  style={[styles.pill, on && styles.pillOn, tooLoose && styles.buttonDisabled]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: tooLoose }}
                  accessibilityLabel={followLabel(f)}>
                  <Text style={[styles.pillText, on && styles.pillTextOn]}>{followLabel(f)}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>
            {FOLLOW_HELP[effective]}
            {follow ? '' : ` (Set by ${fallback.from}.)`}
            {locked ? ` This orchestration is locked at ${followLabel(floor)} or stricter.` : ''}
          </Text>
        </>
      ) : null}
    </View>
  );
}

/** File input that supports BOTH click-to-pick and drag-and-drop. On web,
 *  react-native-web forwards the ref to the underlying DOM node, so we attach
 *  native drag listeners to it — RN's Pressable has no onDrop of its own. */
function FileDropField({
  name,
  file,
  onFile,
}: {
  name: string;
  file?: RunInputFile;
  onFile: (f: RunInputFile) => void;
}) {
  const ref = useRef<unknown>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current as HTMLElement | null;
    if (!el || typeof window === 'undefined') return;
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
    };
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        const r = await readFileToRunInput(f);
        if (r) onFile(r);
      }
    };
    el.addEventListener('dragover', over);
    el.addEventListener('dragenter', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragenter', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [onFile]);

  return (
    <Pressable
      ref={ref as never}
      style={[styles.dropZone, dragging && styles.dropZoneActive]}
      onPress={async () => {
        const f = await pickRunFile();
        if (f) onFile(f);
      }}
      accessibilityRole="button"
      accessibilityLabel={`Choose or drop a document for ${name}`}>
      <Text style={file ? styles.fileChosen : styles.filePrompt}>
        {file
          ? `📎 ${file.filename}  ·  click or drop to replace`
          : dragging
            ? '📥 Drop to attach…'
            : '📎 Choose a document…  or drag & drop here'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(17, 24, 39, 0.5)',
  },
  modalPanel: {
    width: '90%',
    maxWidth: 480,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  modalClose: { fontSize: 24, color: '#6b7280', paddingHorizontal: 8, lineHeight: 24 },
  // Cap the scrollable field area so a modal with many declared inputs plus
  // the instructions box never grows past the viewport.
  modalScroll: { maxHeight: 420 },
  field: { gap: 4, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '600', color: '#374151' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  instructionsInput: { minHeight: 80, paddingTop: 8 },
  dropZone: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#9ca3af',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f9fafb',
  },
  dropZoneActive: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  filePrompt: { fontSize: 14, color: '#6b7280' },
  fileChosen: { fontSize: 14, color: '#111827', fontWeight: '600' },
  errorText: { fontSize: 11, color: '#dc2626', marginTop: 2 },
  subLabel: { marginTop: 6 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#ffffff',
  },
  pillOn: { borderColor: '#2563eb', backgroundColor: '#eff6ff' },
  pillText: { fontSize: 13, color: '#374151' },
  pillTextOn: { color: '#1d4ed8', fontWeight: '600' },
  hint: { fontSize: 11, color: '#6b7280' },
  modalButtonRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  cloneOffer: {
    gap: 8,
    padding: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
  },
  cloneOfferText: { fontSize: 13, color: '#111827' },
  cloneOfferButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  secondaryButton: { borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#ffffff' },
  secondaryButtonText: { color: '#374151', fontWeight: '600', fontSize: 14 },
  button: { paddingVertical: 9, paddingHorizontal: 14, borderRadius: 6 },
  primaryButton: { backgroundColor: '#2563eb' },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },
});
