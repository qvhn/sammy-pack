/**
 * Compatibility pins for two hardening changes, so they stay ADDITIVE:
 *   - `switch.on`: a missing FIELD on an existing value still takes default
 *     (reported); only a reference whose BASE names nothing fails — and
 *     preview agrees with the executor on both.
 *   - registry-wide scrubbing only takes secret-NAMED env values, so plain
 *     configuration (a region, an environment name) is never redacted.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrchestration, type RunEvent } from '../src/llm/executor';
import { previewOrchestration } from '../src/llm/preview';
import { registrySecretValues } from '../src/server/credentials-store';
import { scrubEvent } from '../src/server/scrub-secrets';
import type { Node } from '../src/types';

jest.setTimeout(30_000);

async function run(orchestration: Node): Promise<{ events: RunEvent[]; thrown?: string }> {
  const events: RunEvent[] = [];
  try {
    for await (const ev of runOrchestration({
      orchestration,
      apiKey: '',
      model: 'x',
      waitForApproval: async () => true,
      cancelled: { v: false },
      agentsOverride: [],
      orchestrationsOverride: [],
    } as never)) {
      events.push(ev);
    }
  } catch (e) {
    return { events, thrown: String(e) };
  }
  const re = events.find(e => e.type === 'run-error') as { error?: string } | undefined;
  return { events, thrown: re?.error };
}

const ended = (events: RunEvent[], name: string) =>
  events.some(e => e.type === 'phase-end' && (e as { phaseName: string }).phaseName === name);

describe('switch.on: missing field → default (kept); missing base → fail', () => {
  it('empty search result: ${found.issues.0.key} with default=create (dedup pattern)', async () => {
    const orch = {
      name: 'dedup',
      phases: [
        { name: 'search', code: { source: 'return JSON.stringify({ issues: [] })' }, as: 'found' },
        {
          name: 'gate',
          switch: {
            on: '${found.issues.0.status}',
            cases: { open: { name: 'comment', code: { source: "return 'commented'" } } },
            default: { name: 'create', code: { source: "return 'created'" } },
          },
        },
      ],
    } as unknown as Node;
    const r = await run(orch);
    // Pre-commit behavior: default ran. Now the run fails.
    expect(r.thrown).toBeUndefined();
    expect(ended(r.events, 'create')).toBe(true);
  });

  it('map item missing an optional field', async () => {
    const orch = {
      name: 'm',
      phases: [
        {
          name: 'each',
          map: {
            over: '[{"id":1,"priority":"high"},{"id":2}]',
            body: {
              name: 'by-prio',
              switch: {
                on: '${item.priority}',
                cases: { high: { name: 'page', code: { source: "return 'page'" } } },
                default: { name: 'queue', code: { source: "return 'queue'" } },
              },
            },
          },
        },
      ],
    } as unknown as Node;
    const r = await run(orch);
    // Pre-commit: item 2 took default ("queue"). Now it fails (map partial).
    expect(r.events.some(e => e.type === 'phase-error')).toBe(false);
    expect(ended(r.events, 'queue')).toBe(true);
  });

  it('preview and executor agree: missing field → default (warning)', async () => {
    const orch = {
      name: 'pv',
      vars: { cfg: { tier: 'gold' } },
      phases: [
        {
          name: 'gate',
          switch: {
            on: '${cfg.mode}',
            cases: { fast: { name: 'fast', code: { source: "return 'f'" } } },
            default: { name: 'slow', code: { source: "return 's'" } },
          },
        },
      ],
    } as unknown as Node;
    const plan = JSON.stringify(previewOrchestration(orch));
    const r = await run(orch);
    expect(r.thrown).toBeUndefined();
    expect(ended(r.events, 'slow')).toBe(true);
    expect(r.events.some(e => e.type === 'route-decision' && (e as { unresolved?: string[] }).unresolved?.length)).toBe(true);
    expect(r.events.some(e => e.type === 'interpolation-unresolved')).toBe(false); // not a degradation
    expect(plan).toMatch(/switch-unresolved-field/);
    expect(plan).not.toMatch(/"severity":"error"/);
  });

  it('preview and executor agree: a base that names nothing fails', async () => {
    const orch = {
      name: 'pv2',
      phases: [
        {
          name: 'gate',
          switch: {
            on: '${nope.mode}',
            cases: { fast: { name: 'fast', code: { source: "return 'f'" } } },
            default: { name: 'slow', code: { source: "return 's'" } },
          },
        },
      ],
    } as unknown as Node;
    const r = await run(orch);
    expect(r.thrown).toMatch(/name nothing in this run/);
    expect(ended(r.events, 'slow')).toBe(false);
  });
});

describe('registry-wide scrubbing leaves configuration alone', () => {
  it('an MCP entry with AWS_REGION / NODE_ENV redacts those words from every run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-r7-'));
    const file = path.join(dir, 'credentials.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        aws_mcp: {
          kind: 'mcp-server',
          value: '',
          env: { AWS_REGION: 'us-west-2', NODE_ENV: 'production', GITHUB_OWNER: 'acme-corp', API_TOKEN: 'real-secret-123' },
        },
      }),
    );
    const secrets = registrySecretValues(file);
    const ev = scrubEvent(
      { type: 'phase-end', phaseName: 'p', output: 'Deployed acme-corp/api to production in us-west-2', ts: 0 },
      secrets,
    ) as { output: string };
    await fs.rm(dir, { recursive: true, force: true });
    expect(ev.output).toBe('Deployed acme-corp/api to production in us-west-2');
    expect(secrets).toContain('real-secret-123');
  });
});
