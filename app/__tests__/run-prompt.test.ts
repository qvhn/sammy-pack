/**
 * The run prompt (Run dialog): which links and Jira keys in it are fetched,
 * what the agents get (the words, then the fetched context and attached files
 * under one heading), and which declared inputs a prompt fills.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandRunPrompt, findPromptReferences, promptInputs } from '../src/server/input-resolver';
import { PROMPT_CONTEXT_HEADING, promptWords } from '../src/lib/run-prompt';
import type { InputDecl } from '../src/types';

const atlassian = { site: 'https://acme.atlassian.net', email: 'a@example.test', token: 't' };

/** A fetch that answers Jira issues and GitHub issues it knows, 404 otherwise. */
function fakeFetch(seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(url);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/rest/api/3/issue/PROJ-12')) {
      return json({ key: 'PROJ-12', fields: { summary: 'Login redirects twice', status: { name: 'To Do' }, issuetype: { name: 'Bug' } } });
    }
    if (url.includes('api.github.com/repos/acme/web/issues/7')) {
      return json({ number: 7, title: 'Broken footer', body: 'The footer overlaps.', state: 'open' });
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }) as unknown as typeof fetch;
}

describe('findPromptReferences', () => {
  test('finds issue and page links, and Jira keys when Jira is connected', () => {
    const text =
      'Fix PROJ-12 (see https://github.com/acme/web/issues/7, and https://acme.atlassian.net/wiki/spaces/X/pages/123/Spec). ' +
      'Also https://acme.atlassian.net/browse/OPS-4.';
    expect(findPromptReferences(text, { jiraKeys: true })).toEqual([
      { kind: 'github', value: 'https://github.com/acme/web/issues/7', bare: false },
      { kind: 'confluence', value: 'https://acme.atlassian.net/wiki/spaces/X/pages/123/Spec', bare: false },
      { kind: 'jira', value: 'https://acme.atlassian.net/browse/OPS-4', bare: false },
      { kind: 'jira', value: 'PROJ-12', bare: true },
    ]);
    expect(findPromptReferences(text, { jiraKeys: false }).map(r => r.value)).not.toContain('PROJ-12');
  });

  test('skips plain links, repo links and words that only look like keys', () => {
    expect(
      findPromptReferences('Read https://example.com/docs and https://github.com/acme/web; files are UTF-8, dates ISO-8601', {
        jiraKeys: true,
      }),
    ).toEqual([]);
  });

  test('fetches each reference once and at most six', () => {
    const many = Array.from({ length: 9 }, (_, i) => `ABC-${i + 1}`).join(' ') + ' ABC-1';
    const refs = findPromptReferences(many, { jiraKeys: true });
    expect(refs).toHaveLength(6);
    expect(new Set(refs.map(r => r.value)).size).toBe(6);
  });
});

describe('expandRunPrompt', () => {
  test('words with nothing to fetch come back unchanged', async () => {
    expect(await expandRunPrompt('tidy the README', [], { fetchImpl: fakeFetch() })).toBe('tidy the README');
  });

  test('fetched issues go under the heading, after the words', async () => {
    const out = await expandRunPrompt('Fix PROJ-12 and https://github.com/acme/web/issues/7', [], {
      fetchImpl: fakeFetch(),
      atlassian,
      github: { token: 'g' },
    });
    const [words, context] = out.split(PROMPT_CONTEXT_HEADING);
    expect(words.trim()).toBe('Fix PROJ-12 and https://github.com/acme/web/issues/7');
    expect(context).toContain('#7 Broken footer (open)');
    expect(context).toContain('PROJ-12 — Login redirects twice');
    expect(promptWords(out)).toBe('Fix PROJ-12 and https://github.com/acme/web/issues/7');
  });

  test('a pasted link that fails is noted; a bare key that is not an issue is not', async () => {
    const out = await expandRunPrompt('Fix NOPE-1 per https://github.com/acme/web/issues/999', [], {
      fetchImpl: fakeFetch(),
      atlassian,
    });
    expect(out).toContain('https://github.com/acme/web/issues/999: could not be fetched');
    expect(out).not.toContain('NOPE-1:');
  });

  test('Jira links without a Jira connection say how to fix it', async () => {
    const out = await expandRunPrompt('Do https://acme.atlassian.net/browse/OPS-4', [], { fetchImpl: fakeFetch() });
    expect(out).toContain('no Atlassian connection is set up');
  });

  test('attached files are saved and their text included; images point at the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-files-'));
    try {
      const png = Buffer.from('89504e470d0a1a0a', 'hex');
      const out = await expandRunPrompt(
        'Use these',
        [
          { filename: 'plan.md', mime: 'text/markdown', bytes: Buffer.from('# Plan\nship it\n') },
          { filename: 'shot one.png', mime: 'image/png', bytes: png },
        ],
        { filesDir: dir },
      );
      expect(out).toContain('ship it');
      expect(out).toContain('open it with the Read tool');
      const saved = [...out.matchAll(/saved at (.+?)\)/g)].map(m => m[1]);
      expect(saved).toHaveLength(2);
      expect(path.basename(saved[1])).toBe('shot_one.png');
      expect(await fs.readFile(saved[0], 'utf8')).toBe('# Plan\nship it\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('promptInputs', () => {
  const ticketToPr: InputDecl[] = [
    { name: 'ticket', kind: 'jira', required: true },
    { name: 'repo', kind: 'text', required: true },
  ];
  const wt = [{ repo: '${repo}' }];

  test('the repo fills the input its worktree reads; the prompt the first other', () => {
    expect(promptInputs(ticketToPr, wt, {}, { text: 'PROJ-12', repo: '/w/app', files: 0 })).toEqual({
      values: { repo: { value: '/w/app' }, ticket: { value: 'PROJ-12' } },
      usedText: true,
      usedFiles: 0,
    });
  });

  test('values the request gives are left alone', () => {
    const r = promptInputs(ticketToPr, wt, { ticket: { value: 'X-1' } }, { text: 'words', repo: '/w/app', files: 0 });
    expect(r.values).toEqual({ repo: { value: '/w/app' } });
    expect(r.usedText).toBe(false);
  });

  test('a required input takes the prompt before an optional one; files fill file inputs', () => {
    const decls: InputDecl[] = [
      { name: 'notes', kind: 'text' },
      { name: 'brief', kind: 'text', required: true },
      { name: 'doc', kind: 'file' },
    ];
    expect(promptInputs(decls, [], {}, { text: 'do it', files: 2 })).toEqual({
      values: { brief: { value: 'do it' }, doc: { file: 0 } },
      usedText: true,
      usedFiles: 1,
    });
  });

  test('an empty prompt fills nothing', () => {
    expect(promptInputs(ticketToPr, wt, {}, { text: '  ', files: 0 }).usedText).toBe(false);
  });
});
