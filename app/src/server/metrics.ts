/**
 * Prometheus text exposition (`/metrics` + `/api/metrics`) — hand-rolled on
 * purpose, matching the repo's OTLP stance: no client library, just the
 * text format (version 0.0.4) over data the server already has.
 *
 * Deliberately LOW-CARDINALITY: run counts come from the store's run
 * HEADERS (one bounded listRuns — no event streams are read), agent-slot
 * gauges from the in-process semaphore, process gauges from the runtime.
 * Nothing here scales with event volume, and no label carries a run id /
 * orchestration name — a scrape is O(runs listed), bounded by
 * METRICS_RUN_SCAN_LIMIT, and can never explode a Prometheus index.
 * Cost/latency *distributions* stay on /api/observability (the digest with
 * its own OOM guard); this endpoint is for alerting-grade signals.
 */

import type { RunHeader } from './run-store';
import { agentSlotStats } from '../llm/concurrency';
import { pendingWaitOf } from './wait-resolution';

/** Upper bound on headers scanned per scrape. */
export const METRICS_RUN_SCAN_LIMIT = 1_000;

type MetricLine = { name: string; help: string; type: 'gauge' | 'counter'; rows: Array<{ labels?: Record<string, string>; value: number }> };

function renderMetric(m: MetricLine): string {
  const out: string[] = [
    `# HELP ${m.name} ${m.help}`,
    `# TYPE ${m.name} ${m.type}`,
  ];
  for (const row of m.rows) {
    const labels = row.labels
      ? '{' +
        Object.entries(row.labels)
          .map(([k, v]) => `${k}="${v.replace(/(["\\])/g, '\\$1')}"`)
          .join(',') +
        '}'
      : '';
    out.push(`${m.name}${labels} ${Number.isFinite(row.value) ? row.value : 0}`);
  }
  return out.join('\n');
}

export type MetricsSnapshot = {
  headers: ReadonlyArray<RunHeader>;
  /** Truncation signal: headers.length hit the scan limit. */
  scanTruncated: boolean;
  bootedAtMs: number;
  nowMs?: number;
};

/** Build the exposition text. Pure over its inputs (agent-slot + process
 *  gauges are read here for convenience; tests can still pin the run
 *  metrics exactly via `headers`). */
export function buildMetricsText(snap: MetricsSnapshot): string {
  const now = snap.nowMs ?? Date.now();
  const byStatus = new Map<string, number>();
  let degraded = 0;
  let parkedWaits = 0;
  for (const h of snap.headers) {
    byStatus.set(h.status, (byStatus.get(h.status) ?? 0) + 1);
    if (h.degraded) degraded += 1;
    if (h.status === 'paused' && pendingWaitOf(h.stateJson)) parkedWaits += 1;
  }
  const slots = agentSlotStats();
  const mem = process.memoryUsage();

  const metrics: MetricLine[] = [
    {
      name: 'sammy_runs',
      help: 'Runs currently in the store by status (bounded scan; see sammy_metrics_scan_truncated).',
      type: 'gauge',
      rows: ['running', 'paused', 'interrupted', 'done', 'error', 'cancelled'].map(
        s => ({ labels: { status: s }, value: byStatus.get(s) ?? 0 }),
      ),
    },
    {
      name: 'sammy_runs_degraded',
      help: 'Runs whose terminal was done-but-degraded (swallowed error / partial fan-out / fallback).',
      type: 'gauge',
      rows: [{ value: degraded }],
    },
    {
      name: 'sammy_runs_parked_waits',
      help: 'Paused runs parked on a durable wait (timer or signal), i.e. resumable by the sweeper without a human.',
      type: 'gauge',
      rows: [{ value: parkedWaits }],
    },
    {
      name: 'sammy_metrics_scan_truncated',
      help: '1 when the run scan hit its bound and the sammy_runs counts are a floor, not a census.',
      type: 'gauge',
      rows: [{ value: snap.scanTruncated ? 1 : 0 }],
    },
    {
      name: 'sammy_agent_slots_limit',
      help: 'Global agent-dispatch semaphore size (SAMMY_MAX_CONCURRENT_AGENTS or CPU-derived).',
      type: 'gauge',
      rows: [{ value: slots.limit }],
    },
    {
      name: 'sammy_agent_slots_in_use',
      help: 'Agent dispatches currently holding a slot.',
      type: 'gauge',
      rows: [{ value: slots.inUse }],
    },
    {
      name: 'sammy_agent_queue_depth',
      help: 'Agent dispatches waiting for a slot (FIFO).',
      type: 'gauge',
      rows: [{ value: slots.waiting }],
    },
    {
      name: 'sammy_process_uptime_seconds',
      help: 'Seconds since this server process mounted the API.',
      type: 'gauge',
      rows: [{ value: (now - snap.bootedAtMs) / 1000 }],
    },
    {
      name: 'process_resident_memory_bytes',
      help: 'Resident set size of the server process.',
      type: 'gauge',
      rows: [{ value: mem.rss }],
    },
  ];

  return metrics.map(renderMetric).join('\n') + '\n';
}
