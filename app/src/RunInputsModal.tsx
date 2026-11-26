import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import { cloneRepoUrl, locateRepo } from './api';
import { FolderPicker } from './FolderPicker';
import { type ExecutionMode, type HarnessFollow, type Node } from './types';
import { declaredAgentTools } from './declaredTools';
import { getAllowAgentTools } from './store/apiKey';
import { FOLLOW_HELP, getHarnessSettings } from './store/harness';
import { followLabel, HARNESS_FOLLOWS } from './llm/harness';
import type { RunModeOptions } from './store/runs';
import { lastRepo, recentRepos, rememberRepo } from './store/recentRepos';

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

/** Inputs a `worktrees` entry reads as its repo (`${name}` / `${input.name}`). */
function repoInputNames(orchestration: Node): Set<string> {
  return new Set(
    (orchestration.inputs ?? [])
      .filter(d =>
        (orchestration.worktrees ?? []).some(
          w => w.repo.includes(`\${${d.name}}`) || w.repo.includes(`\${input.${d.name}}`),
        ),
      )
      .map(d => d.name),
  );
}

/** A folder's last path segment, for the repo chip. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

const isRepoUrl = (v: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w.-]+@[\w.-]+:/.test(v);

/**
 * The repository a prompt names, if any: a local folder (`~/…`, or an
 * absolute path under a home or project folder), a repository's web address,
 * or — failing those — the repository of a GitHub issue or pull request it
 * links. Prose like "the /login page" is not a folder.
 */
export function detectRepo(text: string): string | undefined {
  const local = text.match(
    /(?:^|[\s("'`])((?:~|\/(?:Users|home|Volumes|opt|srv|workspace|workspaces|projects|code|src))(?:\/[\w.@+-]+)+|[A-Za-z]:\\(?:[\w.@+-]+\\?)+)\/?(?=$|[\s,;:!?)"'`]|\.(?:\s|$))/,
  );
  if (local) return local[1].replace(/[\\/.]+$/, '');
  const hosts = 'github\\.com|gitlab\\.com|bitbucket\\.org';
  const repoUrl = text.match(
    new RegExp(`https?://(?:www\\.)?(${hosts})/([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?(?=$|[\\s,;:!?)"'\`]|\\.(?:\\s|$))`, 'i'),
  );
  if (repoUrl) return `https://${repoUrl[1]}/${repoUrl[2]}/${repoUrl[3]}`;
  const ssh = text.match(/\bgit@[\w.-]+:[\w.-]+\/[\w.-]+?\.git\b/);
  if (ssh) return ssh[0];
  const issue = text.match(
    new RegExp(`https?://(?:www\\.)?(${hosts})/([\\w.-]+)/([\\w.-]+)/(?:issues|pull|-/issues|-/merge_requests)/\\d+`, 'i'),
  );
  if (issue) return `https://${issue[1]}/${issue[2]}/${issue[3]}`;
  return undefined;
}

type RepoSource = 'remembered' | 'message' | 'picked';

/**
 * The Run dialog: a prompt and its attachments, the way you talk to Claude
 * Code — no form. The prompt becomes the run's initial input (`${input}`);
 * the server fetches the issues and pages it links and fills any declared
 * `inputs` from it (an orchestration written for typed fields runs unchanged).
 *
 *  - **Prompt** — Enter runs, Shift+Enter is a new line.
 *  - **Files** — attach, drop on the dialog, or paste; the agents get them.
 *  - **Repo** — where the run works, in its own worktree. Opens on the last
 *    repo this pipeline used, follows a repo the prompt names, and Change
 *    picks another. Without one the run works in an empty folder of its own.
 *  - **How to run** — Pipeline or Harness.
 *
 * `defaultInstructions` pre-fills the prompt (replay). Renders nothing only
 * when no orchestration is selected.
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
  /** `values` is always empty from this dialog (declared inputs are filled
   *  server-side from the prompt); `mode` carries the prompt flag, the repo,
   *  the attachments and the Pipeline / Harness choice. */
  onRun: (values: RunInputValues, instructions: string, mode: RunModeOptions) => void;
  defaultInstructions?: string;
  /** Why the last ▶ Run from this dialog didn't start (the dialog stays open to say so). */
  error?: string | null;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<RunInputFile[]>([]);
  const [repo, setRepo] = useState('');
  const [repoSource, setRepoSource] = useState<RepoSource | null>(null);
  const [editingRepo, setEditingRepo] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cloneOffer, setCloneOffer] = useState<{
    url: string;
    cloneTo: string | null;
    busy: boolean;
    error?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  // The "what's missing" hint waits until the user has tried to run.
  const [attempted, setAttempted] = useState(false);
  // Pipeline or harness, and the harness's strictness. `follow` stays null
  // until the user picks one, so an untouched dialog leaves the decision to
  // the orchestration / Settings (and the run records that as its source).
  const [execution, setExecution] = useState<ExecutionMode>('pipeline');
  const [follow, setFollow] = useState<HarnessFollow | null>(null);
  const [workspaceFollow, setWorkspaceFollow] = useState<HarnessFollow | null>(null);
  const promptRef = useRef<TextInputInstance | null>(null);
  const panelRef = useRef<unknown>(null);

  const remembered = (o: Node | null) => (o ? lastRepo(o.name, 'repo') : undefined);

  useEffect(() => {
    const seededText = defaultInstructions ?? '';
    setText(seededText);
    setFiles([]);
    const named = detectRepo(seededText);
    const last = remembered(orchestration);
    setRepo(named ?? last ?? '');
    setRepoSource(named ? 'message' : last ? 'remembered' : null);
    setEditingRepo(false);
    setCloneOffer(null);
    setChecking(false);
    setAttempted(false);
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
    promptRef.current?.focus?.();
  }, [orchestration]);

  // Escape closes the dialog (web). Not while a clone is in flight — that
  // request would keep running behind a closed dialog — and not while the
  // folder picker is open: there Escape closes the picker.
  const cloneBusy = !!cloneOffer?.busy;
  useEffect(() => {
    if (!orchestration || cloneBusy || browsing) return;
    const g = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: { key?: string }) => void, capture?: boolean) => void;
      removeEventListener?: (t: string, fn: (e: { key?: string }) => void, capture?: boolean) => void;
    };
    if (!g.addEventListener || !g.removeEventListener) return;
    const onKey = (e: { key?: string }) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase: react-native-web's TextInput stops every keydown from
    // bubbling, and the prompt box has the focus.
    g.addEventListener('keydown', onKey, true);
    return () => g.removeEventListener?.('keydown', onKey, true);
  }, [orchestration, cloneBusy, browsing, onClose]);

  // Files dropped anywhere on the dialog, or pasted into the prompt (web).
  const addFiles = async (list: FileList | File[] | null | undefined) => {
    const picked = [...(list ?? [])];
    if (picked.length === 0) return;
    const read = (await Promise.all(picked.map(readFileToRunInput))).filter(
      (f): f is RunInputFile => f !== null,
    );
    if (read.length > 0) setFiles(fs => [...fs, ...read]);
  };
  useEffect(() => {
    const panel = panelRef.current as HTMLElement | null;
    const prompt = promptRef.current as unknown as HTMLElement | null;
    if (!panel?.addEventListener || typeof window === 'undefined') return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes?.('Files')) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget && panel.contains(e.relatedTarget as globalThis.Node)) return;
      setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      setDragging(false);
      void addFiles(e.dataTransfer.files);
    };
    const paste = (e: ClipboardEvent) => {
      if (!e.clipboardData?.files?.length) return;
      e.preventDefault();
      void addFiles(e.clipboardData.files);
    };
    panel.addEventListener('dragover', over);
    panel.addEventListener('dragenter', over);
    panel.addEventListener('dragleave', leave);
    panel.addEventListener('drop', drop);
    prompt?.addEventListener?.('paste', paste);
    return () => {
      panel.removeEventListener('dragover', over);
      panel.removeEventListener('dragenter', over);
      panel.removeEventListener('dragleave', leave);
      panel.removeEventListener('drop', drop);
      prompt?.removeEventListener?.('paste', paste);
    };
  }, [orchestration]);

  if (!orchestration) return null;
  const decls = orchestration.inputs ?? [];
  const repoInputs = repoInputNames(orchestration);
  // An orchestration whose worktrees name their own repos has nothing to pick.
  const fixedWorktrees = (orchestration.worktrees ?? []).length > 0 && repoInputs.size === 0;
  const needsRepo = repoInputs.size > 0;
  const needsText = decls.some(d => d.required && d.kind !== 'file' && !repoInputs.has(d.name));
  const needsFile = decls.some(d => d.required && d.kind === 'file');
  const missing = [
    ...(needsText && !text.trim() ? ['say what to work on'] : []),
    ...(needsRepo && !repo.trim() ? ['choose the repo it works in'] : []),
    ...(needsFile && files.length === 0 ? ['attach a file'] : []),
  ];

  const onText = (t: string) => {
    setText(t);
    if (repoSource === 'picked') return;
    const named = detectRepo(t);
    if (named) {
      setRepo(named);
      setRepoSource('message');
    } else if (repoSource === 'message') {
      const last = remembered(orchestration);
      setRepo(last ?? '');
      setRepoSource(last ? 'remembered' : null);
    }
  };
  const pickRepo = (r: string) => {
    setRepo(r);
    setRepoSource(r.trim() ? 'picked' : null);
    setEditingRepo(false);
  };

  const submit = async () => {
    let target = repo.trim();
    if (target && isRepoUrl(target)) {
      setChecking(true);
      try {
        const loc = await locateRepo(target);
        if (!loc.local) {
          setCloneOffer({ url: target, cloneTo: loc.cloneTo, busy: false });
          return;
        }
        target = loc.local;
      } catch (err) {
        setCloneOffer({ url: target, cloneTo: null, busy: false, error: (err as Error).message });
        return;
      } finally {
        setChecking(false);
      }
    }
    if (target) rememberRepo(orchestration.name, 'repo', target);
    onRun({}, text.trim(), {
      prompt: true,
      ...(target ? { repo: target } : {}),
      ...(files.length > 0
        ? { attachments: files.map(f => ({ filename: f.filename, mediaType: f.mediaType, data: f.data })) }
        : {}),
      ...(execution !== (orchestration.execution ?? 'pipeline') ? { execution } : {}),
      ...(execution === 'harness' && follow ? { follow } : {}),
    });
  };

  // Run if nothing required is missing; otherwise say what is.
  const trySubmit = () => {
    if (checking || cloneOffer) return;
    if (missing.length > 0) {
      setAttempted(true);
      return;
    }
    void submit();
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

  const recent = recentRepos().filter(r => r !== repo.trim());
  const repoHint =
    repoSource === 'message' ? 'from your message' : repoSource === 'remembered' ? 'last used' : null;

  return (
    <View style={styles.modalOverlay}>
      <Pressable style={styles.modalBackdrop} onPress={browsing ? undefined : onClose} />
      <View ref={panelRef as never} style={[styles.modalPanel, dragging && styles.modalPanelDragging]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>
            ▶ Run "{orchestration.name}"
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.modalClose}>×</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.field}>
            <TextInput
              ref={promptRef}
              value={text}
              onChangeText={onText}
              onKeyPress={e => {
                const ne = e.nativeEvent as { key?: string; shiftKey?: boolean; isComposing?: boolean };
                if (ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
                  e.preventDefault();
                  trySubmit();
                }
              }}
              placeholder={
                decls.length > 0 && decls[0].description
                  ? `What should it work on? ${runInputPlaceholder(decls.find(d => !repoInputs.has(d.name)) ?? decls[0])}…`
                  : 'What should it work on? Paste a ticket or link, or describe it.'
              }
              accessibilityLabel="Prompt"
              style={[styles.input, styles.promptInput]}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              autoCapitalize="sentences"
            />
            <Text style={styles.promptHint}>
              Enter runs · Shift+Enter for a new line · links to issues and pages are fetched for the agents
            </Text>
          </View>

          <View style={styles.attachRow}>
            {files.map((f, i) => (
              <View key={`${f.filename}-${i}`} style={styles.fileChip}>
                <Text style={styles.fileChipText} numberOfLines={1}>
                  📎 {f.filename}
                </Text>
                <Pressable
                  onPress={() => setFiles(fs => fs.filter((_, j) => j !== i))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${f.filename}`}>
                  <Text style={styles.fileChipRemove}>×</Text>
                </Pressable>
              </View>
            ))}
            <Pressable
              onPress={async () => {
                const f = await pickRunFile();
                if (f) setFiles(fs => [...fs, f]);
              }}
              style={[styles.button, styles.secondaryButton, styles.smallButton]}
              accessibilityRole="button"
              accessibilityLabel="Attach a file">
              <Text style={styles.secondaryButtonText}>{dragging ? '📥 Drop to attach' : '📎 Attach'}</Text>
            </Pressable>
          </View>

          {fixedWorktrees ? null : (
            <View style={styles.field}>
              <Text style={styles.label}>
                Repo{needsRepo ? ' *' : ''}
                {repoHint ? <Text style={styles.labelHint}>{`  ·  ${repoHint}`}</Text> : null}
              </Text>
              {repo.trim() && !editingRepo ? (
                <View style={styles.inputRow}>
                  <View style={styles.repoChip} accessibilityLabel={`repo: ${repo}`}>
                    <Text style={styles.repoChipName}>{folderName(repo)}</Text>
                    <Text style={styles.repoChipPath} numberOfLines={1}>
                      {repo}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setEditingRepo(true)}
                    style={[styles.button, styles.secondaryButton]}
                    accessibilityRole="button"
                    accessibilityLabel="Change the repo">
                    <Text style={styles.secondaryButtonText}>Change</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <View style={styles.inputRow}>
                    <TextInput
                      value={repo}
                      onChangeText={r => {
                        // Stay in the field while typing; Enter or a pick shows the chip.
                        setEditingRepo(true);
                        setRepo(r);
                        setRepoSource(r.trim() ? 'picked' : null);
                      }}
                      onSubmitEditing={() => repo.trim() && setEditingRepo(false)}
                      placeholder={
                        needsRepo
                          ? 'A local folder or the repository’s URL'
                          : 'Optional — without one the run works in an empty folder'
                      }
                      accessibilityLabel="Repo path or URL"
                      style={[styles.input, styles.inputGrow]}
                      autoCapitalize="none"
                    />
                    <Pressable
                      onPress={() => setBrowsing(true)}
                      style={[styles.button, styles.secondaryButton]}
                      accessibilityRole="button"
                      accessibilityLabel="Browse for the repo folder">
                      <Text style={styles.secondaryButtonText}>Browse…</Text>
                    </Pressable>
                  </View>
                  {recent.length > 0 ? (
                    <View style={styles.recentRepos}>
                      <Text style={styles.recentLabel}>Recent</Text>
                      {recent.map(r => (
                        <Pressable
                          key={r}
                          onPress={() => pickRepo(r)}
                          style={styles.recentRepo}
                          accessibilityRole="button"
                          accessibilityLabel={`Use ${r}`}>
                          <Text style={styles.repoChipName}>{folderName(r)}</Text>
                          <Text style={styles.repoChipPath} numberOfLines={1}>
                            {r}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </>
              )}
              {repo.trim() ? (
                <Text style={styles.promptHint}>The run works in its own worktree on a new branch — never in your checkout.</Text>
              ) : null}
            </View>
          )}

          <RunModePicker
            orchestration={orchestration}
            execution={execution}
            onExecution={setExecution}
            follow={follow}
            onFollow={setFollow}
            workspaceFollow={workspaceFollow}
          />
        </ScrollView>
        {attempted && missing.length > 0 ? (
          <Text style={styles.errorText}>{`To run, ${missing.join(' and ')}.`}</Text>
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
              // Stays pressable while something is missing so a press can
              // reveal WHAT; it just looks (and acts) inert.
              onPress={trySubmit}
              disabled={checking}
              accessibilityState={{ disabled: missing.length > 0 || checking }}
              style={[
                styles.button,
                styles.primaryButton,
                (missing.length > 0 || checking) && styles.buttonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Run with inputs">
              <Text style={styles.primaryButtonText}>{checking ? 'Checking…' : '▶ Run'}</Text>
            </Pressable>
          </View>
        )}
      </View>
      {browsing ? (
        <FolderPicker
          start={repo || undefined}
          onClose={() => setBrowsing(false)}
          onPick={dir => {
            pickRepo(dir);
            setBrowsing(false);
          }}
        />
      ) : null}
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
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputGrow: { flex: 1 },
  promptInput: { minHeight: 110 },
  promptHint: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  labelHint: { fontWeight: '400', color: '#6b7280' },
  attachRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 12 },
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 260,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#f9fafb',
  },
  fileChipText: { fontSize: 12, color: '#374151', flexShrink: 1 },
  fileChipRemove: { fontSize: 14, color: '#6b7280' },
  smallButton: { paddingVertical: 4, paddingHorizontal: 10 },
  modalPanelDragging: { borderWidth: 2, borderColor: '#2563eb', borderStyle: 'dashed' },
  repoChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f9fafb',
  },
  repoChipName: { fontSize: 14, fontWeight: '600', color: '#111827' },
  repoChipPath: { fontSize: 12, color: '#6b7280' },
  recentRepos: { marginTop: 6, gap: 4 },
  recentLabel: { fontSize: 11, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase' },
  recentRepo: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
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
