/**
 * Tests for the phase liveness heartbeat — the silent-phase guard.
 *
 * The SDK stream consumes many message classes without yielding anything
 * (thinking deltas, streamed tool-call arguments, block boundaries), so a
 * hard-working turn could look dead for over an hour: no events persisted,
 * AND — because withStallGuard resets only on emitted events — the stall
 * clock starving on a healthy phase. sdk-stream now emits a throttled
 * `heartbeat` chunk for that silent class; the executor forwards it as a
 * persisted `phase-heartbeat` run event. These tests pin the executor-side
 * semantics with a stub stream:
 *
 *   1. heartbeat StreamEvents surface as phase-heartbeat run events with
 *      the via/counts payload intact (the silent-tail diagnosis record)
 *   2. heartbeats FEED the stall watchdog: a phase whose stream produces
 *      only heartbeats for longer than stallTimeout completes fine
 *   3. control: the same silence WITHOUT heartbeats trips the watchdog
 *      (node-stalled + StallError → run error), proving 2 tested the guard
 */

import {
  runOrchestration,
  type RunEvent,
  type StreamFn,
} from '../src/llm/executor';
import type { Node } from '../src/types';

const AGENTS = [{ name: 'a', raw: '---\nname: a\n---\nAgent A.' }];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function collect(
  orchestration: Node,
  streamFn: StreamFn,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runOrchestration({
    orchestration,
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    streamFn,
    waitForApproval: async () => true,
    cancelled: { v: false },
    agentsOverride: AGENTS,
    orchestrationsOverride: [],
  })) {
    events.push(ev);
  }
  return events;
}

const FLOW: Node = {
  name: 'flow',
  phases: [{ name: 'work', agent: 'agents/a.md', stallTimeout: 0.4 }],
};

describe('phase-heartbeat — liveness through silent SDK activity', () => {
  test('heartbeat chunks surface as phase-heartbeat events with via/counts intact', async () => {
    const streamFn: StreamFn = async function* () {
      yield {
        type: 'heartbeat',
        via: 'input_json_delta',
        messages: 42,
        toolUses: 3,
        textBytes: 0,
      };
      yield { type: 'text-delta', text: 'done-text' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(FLOW, streamFn);
    const beat = events.find(e => e.type === 'phase-heartbeat');
    expect(beat).toMatchObject({
      phaseName: 'work',
      via: 'input_json_delta',
      messages: 42,
      toolUses: 3,
      textBytes: 0,
    });
    expect(events.some(e => e.type === 'run-end')).toBe(true);
  });

  test('heartbeats FEED the stall watchdog — an event-silent but beating phase completes', async () => {
    const streamFn: StreamFn = async function* () {
      // 1s of "silent tail": nothing but beats, each within the 0.4s stall
      // window. Pre-fix this exact stream shape (silent work) stalled out.
      for (let i = 0; i < 10; i++) {
        await sleep(100);
        yield {
          type: 'heartbeat',
          via: 'thinking_delta',
          messages: 1,
          toolUses: 0,
          textBytes: 0,
        };
      }
      yield { type: 'text-delta', text: 'finished' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(FLOW, streamFn);
    expect(events.some(e => e.type === 'node-stalled')).toBe(false);
    expect(events.some(e => e.type === 'run-end')).toBe(true);
    expect(
      events.filter(e => e.type === 'phase-heartbeat').length,
    ).toBeGreaterThanOrEqual(8);
  }, 15000);

  test('control: the same silence WITHOUT beats trips the watchdog', async () => {
    const streamFn: StreamFn = async function* () {
      yield { type: 'text-delta', text: 'starting…' };
      await sleep(800); // > 0.4s stallTimeout, no events
      yield { type: 'text-delta', text: 'too late' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const events = await collect(FLOW, streamFn);
    expect(
      events.some(e => e.type === 'node-stalled' && e.phaseName === 'work'),
    ).toBe(true);
    expect(events.some(e => e.type === 'run-end')).toBe(false);
  }, 15000);
});
