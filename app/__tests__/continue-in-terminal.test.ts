/**
 * "Continue in terminal" for pipeline runs: each agent step records the
 * Claude Code session it ran in (from the SDK's init message), the Runs log
 * marks the steps that have one, and the command reopens the step's session
 * as a fork in the folder it ran from. The terminal choice is a settings key
 * of its own.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunEvent } from '../src/llm/executor';
import { pickStepSession, stepResumeCommand, stepSessions } from '../src/lib/step-session';
import { groupEvents } from '../src/pages/RunsPage';
import { readHarnessSettingsSync, writeHarnessSettings } from '../src/server/harness-settings';
import { streamSdk, type SdkQueryFn, type SdkStreamChunk } from '../src/server/sdk-stream';

const session = (phaseName: string, sessionId: string, cwd = '/work'): RunEvent => ({
  type: 'phase-session',
  phaseName,
  sessionId,
  cwd,
  ts: 1,
});

describe('a step’s Claude Code session', () => {
  it('comes from the SDK’s init message, with the folder the agent runs in', async () => {
    const queryFn = (() =>
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'abc-123', cwd: '/repo/wt' };
        yield { type: 'result', subtype: 'success' };
      })()) as unknown as SdkQueryFn;
    const chunks: SdkStreamChunk[] = [];
    for await (const c of streamSdk({
      userMessage: 'hi',
      model: 'claude-sonnet-4-6',
      abortController: new AbortController(),
      queryFn,
    })) {
      chunks.push(c);
    }
    expect(chunks[0]).toEqual({ type: 'session', sessionId: 'abc-123', cwd: '/repo/wt' });
  });

  it('keeps each step’s latest session, in the order the steps started', () => {
    const events = [session('plan', 'a'), session('build', 'b'), session('plan', 'c')];
    expect(stepSessions(events).map(s => `${s.phaseName}:${s.sessionId}`)).toEqual(['build:b', 'plan:c']);
    expect(pickStepSession(events)?.sessionId).toBe('c');
    expect(pickStepSession(events, 'build')?.sessionId).toBe('b');
    expect(pickStepSession(events, 'missing')).toBeNull();
    expect(pickStepSession([])).toBeNull();
  });

  it('reopens as a fork in its folder, quoted for the shell', () => {
    expect(stepResumeCommand({ sessionId: 's1', cwd: "/tmp/it's here" })).toBe(
      "mkdir -p '/tmp/it'\\''s here' && cd '/tmp/it'\\''s here' && claude --resume 's1' --fork-session",
    );
    expect(stepResumeCommand({ sessionId: 's1', cwd: '' })).toBe("claude --resume 's1' --fork-session");
  });

  it('marks the step in the Runs log', () => {
    const events: RunEvent[] = [
      { type: 'run-start', orchestrationName: 'o', ts: 1 },
      { type: 'phase-start', phaseName: 'plan', ts: 1 },
      session('plan', 'a'),
      { type: 'phase-start', phaseName: 'format', agentPath: 'code', ts: 1 },
    ];
    const phases = groupEvents(events).flatMap(b => (b.kind === 'phase' ? [[b.name, !!b.session]] : []));
    expect(phases).toEqual([
      ['plan', true],
      ['format', false],
    ]);
  });
});

describe('the terminal app setting', () => {
  it('is written on its own, keeping the strictness, and an unknown app is no choice', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-settings-')), 'harness.json');
    expect(readHarnessSettingsSync(file)).toEqual({ follow: null, terminal: null });
    await writeHarnessSettings(file, { follow: 'loose' });
    expect(await writeHarnessSettings(file, { terminal: 'cmux' })).toEqual({ follow: 'loose', terminal: 'cmux' });
    expect(readHarnessSettingsSync(file)).toEqual({ follow: 'loose', terminal: 'cmux' });
    await writeHarnessSettings(file, { terminal: 'xterm' as never });
    expect(readHarnessSettingsSync(file).terminal).toBeNull();
  });
});
