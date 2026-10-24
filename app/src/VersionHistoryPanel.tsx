import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  getVersionContent,
  listVersions,
  type VersionCommit,
} from './api';

/** Compact git-history viewer for a single file (agent or
 *  orchestration). Lists commits touching the file; click a commit to
 *  inline-load its content at that sha. Used by AgentsPage and
 *  PipelinesPage to give users a "what changed?" answer without
 *  leaving the app.
 *
 *  Backend (`/api/versions/:scope/:name`) shells out to `git log`
 *  against the repo root — works only inside an actual git workspace.
 *  Non-git workspaces get an empty list + a hint. */
export function VersionHistoryPanel({
  scope,
  name,
  currentContent,
}: {
  scope: 'agents' | 'examples';
  name: string;
  /** Live content of the file in the editor. When provided, the diff
   *  toggle is enabled and renders the selected commit's content vs
   *  this. Without it, only the raw-at-sha view is available. */
  currentContent?: string;
}) {
  const [commits, setCommits] = useState<VersionCommit[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error' | 'empty'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const diff = useMemo(() => {
    if (!showDiff || openContent == null || currentContent == null) return null;
    return diffLines(openContent, currentContent);
  }, [showDiff, openContent, currentContent]);

  useEffect(() => {
    setOpenSha(null);
    setOpenContent(null);
    setStatus('loading');
    listVersions(scope, name)
      .then(c => {
        setCommits(c);
        setStatus(c.length === 0 ? 'empty' : 'idle');
      })
      .catch(err => {
        setError((err as Error).message);
        setStatus('error');
      });
  }, [scope, name]);

  async function open(sha: string) {
    if (openSha === sha) {
      setOpenSha(null);
      setOpenContent(null);
      return;
    }
    setOpenSha(sha);
    setOpenContent(null);
    try {
      const r = await getVersionContent(scope, name, sha);
      setOpenContent(r.content);
    } catch (err) {
      setOpenContent(`(failed to load: ${(err as Error).message})`);
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>git history · {scope}/{name}</Text>
      {status === 'loading' && <Text style={styles.dim}>loading…</Text>}
      {status === 'error' && (
        <Text style={styles.err}>error: {error}</Text>
      )}
      {status === 'empty' && (
        <Text style={styles.dim}>
          No git history (file not yet committed, or workspace isn't a git
          repository).
        </Text>
      )}
      {status === 'idle' && (
        <ScrollView style={styles.list} nestedScrollEnabled>
          {commits.map(c => (
            <View key={c.sha} style={styles.commitWrap}>
              <Pressable
                onPress={() => open(c.sha)}
                style={[styles.commit, openSha === c.sha && styles.commitOpen]}>
                <Text style={styles.commitSha}>{c.sha.slice(0, 8)}</Text>
                <Text style={styles.commitMsg} numberOfLines={1}>
                  {c.message}
                </Text>
                <Text style={styles.commitMeta}>{c.author} · {c.date.slice(0, 16)}</Text>
              </Pressable>
              {openSha === c.sha && (
                <View style={styles.contentBox}>
                  {currentContent != null && (
                    <View style={styles.diffToggleRow}>
                      <Pressable
                        onPress={() => setShowDiff(false)}
                        style={[styles.diffToggle, !showDiff && styles.diffToggleActive]}>
                        <Text style={[styles.diffToggleText, !showDiff && styles.diffToggleTextActive]}>
                          content
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setShowDiff(true)}
                        style={[styles.diffToggle, showDiff && styles.diffToggleActive]}>
                        <Text style={[styles.diffToggleText, showDiff && styles.diffToggleTextActive]}>
                          diff vs current
                        </Text>
                      </Pressable>
                    </View>
                  )}
                  {openContent === null ? (
                    <Text style={styles.dim}>loading content…</Text>
                  ) : showDiff && diff ? (
                    <ScrollView style={styles.contentScroll} nestedScrollEnabled>
                      {diff.map((line, i) => (
                        <Text
                          key={i}
                          selectable
                          style={[
                            styles.diffLine,
                            line.kind === 'add' && styles.diffLineAdd,
                            line.kind === 'del' && styles.diffLineDel,
                          ]}>
                          {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                          {line.text}
                        </Text>
                      ))}
                    </ScrollView>
                  ) : (
                    <ScrollView style={styles.contentScroll} nestedScrollEnabled>
                      <Text style={styles.contentText} selectable>
                        {openContent}
                      </Text>
                    </ScrollView>
                  )}
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Line-level diff via LCS. `from` is the older (at-sha) content; `to`
 *  is the current. Returns ops with `kind`: same / add (in current,
 *  not in sha) / del (in sha, not in current). */
function diffLines(
  from: string,
  to: string,
): Array<{ kind: 'same' | 'add' | 'del'; text: string }> {
  const a = from.split('\n');
  const b = to.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ kind: 'same' | 'add' | 'del'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: 'del', text: a[i] });
    i++;
  }
  while (j < n) {
    out.push({ kind: 'add', text: b[j] });
    j++;
  }
  return out;
}

const styles = StyleSheet.create({
  panel: {
    padding: 8,
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 6,
  },
  title: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  dim: { fontSize: 11, color: '#9ca3af' },
  err: { fontSize: 11, color: '#b91c1c' },
  list: { maxHeight: 320 },
  commitWrap: { borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  commit: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commitOpen: { backgroundColor: '#eff6ff' },
  commitSha: { fontSize: 10, color: '#2563eb', fontFamily: 'Menlo' },
  commitMsg: { flex: 1, fontSize: 11, color: '#111827' },
  commitMeta: { fontSize: 10, color: '#6b7280', fontFamily: 'Menlo' },
  contentBox: {
    backgroundColor: '#020617',
    borderRadius: 4,
    padding: 8,
    margin: 4,
  },
  contentScroll: { maxHeight: 280 },
  contentText: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#e2e8f0',
    lineHeight: 14,
  },
  diffToggleRow: { flexDirection: 'row', gap: 6, marginBottom: 6 },
  diffToggle: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#1e293b',
    borderRadius: 4,
  },
  diffToggleActive: { backgroundColor: '#2563eb' },
  diffToggleText: { fontSize: 10, color: '#94a3b8', fontWeight: '600' },
  diffToggleTextActive: { color: '#ffffff' },
  diffLine: {
    fontFamily: 'Menlo',
    fontSize: 10,
    color: '#cbd5e1',
    lineHeight: 14,
  },
  diffLineAdd: { backgroundColor: '#064e3b', color: '#a7f3d0' },
  diffLineDel: { backgroundColor: '#7f1d1d', color: '#fecaca' },
});
