/**
 * Tests for server/metrics.ts — the Prometheus text exposition.
 * Run counts / degraded / parked-wait gauges are pinned exactly from
 * synthetic headers; process + slot gauges just need to render sanely.
 */

import { buildMetricsText, METRICS_RUN_SCAN_LIMIT } from '../src/server/metrics';
import type { RunHeader } from '../src/server/run-store';

const h = (
  id: string,
  status: RunHeader['status'],
  extra: Partial<RunHeader> = {},
): RunHeader =>
  ({
    id,
    orchestrationName: 'flow',
    startedAt: 0,
    endedAt: null,
    status,
    orchestrationSnapshot: null,
    initialInput: null,
    currentPath: null,
    stateJson: null,
    lastOutput: null,
    pausedFor: null,
    completedLeaves: [],
    updatedAt: 0,
    ownerId: 'system',
    concurrencyGroup: null,
    degraded: false,
    degradationReasons: [],
    ...extra,
  }) as RunHeader;

function metricValue(text: string, line: string): number {
  const m = text.split('\n').find(l => l.startsWith(line + ' '));
  if (!m) throw new Error(`metric line not found: ${line}\n${text}`);
  return Number(m.slice(line.length + 1));
}

describe('buildMetricsText', () => {
  test('run counts by status, degraded, and parked-wait gauges', () => {
    const text = buildMetricsText({
      headers: [
        h('r1', 'running'),
        h('r2', 'done'),
        h('r3', 'done', { degraded: true }),
        h('r4', 'paused'), // lock gate — not a parked wait
        h('r5', 'paused', {
          stateJson: {
            pendingWait: { replayKey: 'w', kind: 'timer', resumeAt: 99 },
          },
        }),
        h('r6', 'error'),
      ],
      scanTruncated: false,
      bootedAtMs: 0,
      nowMs: 10_000,
    });
    expect(metricValue(text, 'sammy_runs{status="running"}')).toBe(1);
    expect(metricValue(text, 'sammy_runs{status="done"}')).toBe(2);
    expect(metricValue(text, 'sammy_runs{status="paused"}')).toBe(2);
    expect(metricValue(text, 'sammy_runs{status="error"}')).toBe(1);
    expect(metricValue(text, 'sammy_runs{status="cancelled"}')).toBe(0);
    expect(metricValue(text, 'sammy_runs_degraded')).toBe(1);
    expect(metricValue(text, 'sammy_runs_parked_waits')).toBe(1);
    expect(metricValue(text, 'sammy_metrics_scan_truncated')).toBe(0);
    expect(metricValue(text, 'sammy_process_uptime_seconds')).toBe(10);
  });

  test('truncation flag + well-formed exposition (HELP/TYPE per metric, trailing newline)', () => {
    const text = buildMetricsText({
      headers: [],
      scanTruncated: true,
      bootedAtMs: 0,
    });
    expect(metricValue(text, 'sammy_metrics_scan_truncated')).toBe(1);
    expect(text.endsWith('\n')).toBe(true);
    for (const name of [
      'sammy_runs',
      'sammy_agent_slots_limit',
      'sammy_agent_slots_in_use',
      'sammy_agent_queue_depth',
      'process_resident_memory_bytes',
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} gauge`);
    }
  });

  test('scan limit is a sane bound', () => {
    expect(METRICS_RUN_SCAN_LIMIT).toBeGreaterThanOrEqual(100);
  });
});
