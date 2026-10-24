/**
 * The four spend surfaces report the SAME number for the same run.
 *
 * `lib/spend` made "which events count" one answer, but an answer only one
 * caller reads is a convention, not a contract. The caps, `sumCostUsd`, the
 * mid-run gate and the Runs card fold `phase-end` + `phase-error` while
 * `/api/cost` and `/api/observability` folded `phase-end` alone, so one
 * retried run read $0.02 on the Runs page and
 * $0.01 on the Cost page — and the Cost page is the one an operator opens to
 * reconcile against a 402 they just hit. The disagreement was exactly what
 * the retried attempts spent, which is the figure a spend cap exists to see.
 *
 * So this pins AGREEMENT across the surfaces rather than each surface's
 * arithmetic (`spend-definition.test.ts` owns the arithmetic): a fixture run
 * whose stream holds a failed attempt and a successful retry must report one
 * total through `/api/cost`, `/api/observability`, `/api/runs/:id` and
 * `lib/spend` itself. Dropping `phase-error` from any one of them turns this
 * red — which is what makes the next change unable to move three and leave
 * one behind.
 *
 * The fixture is mirrored in through `POST /api/runs` rather than executed:
 * a real agent phase cannot be driven without a model, and what is under
 * test is the FOLD, which reads the durable stream either way.
 */

import {
  getJson,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';
import { foldSpend } from '../src/lib/spend';

jest.setTimeout(60_000);

const ORCH = 'spend-agree-orch';
const RUN_ID = 'spend-agree-run';

/** One phase, two attempts: the first failed after spending, `retry` paid
 *  again, the second succeeded. Both attempts carry their own figures. */
const EVENTS = [
  { type: 'run-start', orchestrationName: ORCH, ts: 1_000 },
  {
    type: 'phase-error',
    phaseName: 'build',
    error: 'contract violation',
    inputTokens: 1_000,
    outputTokens: 500,
    costUsd: 0.01,
    ts: 1_100,
  },
  {
    type: 'phase-end',
    phaseName: 'build',
    output: 'ok',
    inputTokens: 1_000,
    outputTokens: 500,
    costUsd: 0.01,
    ts: 1_200,
  },
  // The cumulative `cost` event: a running total of the whole run, which no
  // fold may add in (it would double-count every figure above).
  { type: 'cost', costUsd: 0.02, inputTokens: 2_000, outputTokens: 1_000, ts: 1_300 },
  { type: 'run-end', ts: 1_400 },
];

/** What the stream above spent, written out rather than derived: a fixture
 *  that asks `lib/spend` what to expect would move with the module, and then
 *  every "agrees" assertion below would hold while all four surfaces drifted
 *  together. The floor case pins the module against these same numbers. */
const EXPECTED = { inputTokens: 2_000, outputTokens: 1_000, costUsd: 0.02 };

type CostDigest = {
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  perRun: Array<{ id: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  perPhase: Record<
    string,
    Array<{ phaseName: string; costUsd: number; failed?: boolean }>
  >;
};
type ObservabilityDigest = {
  totals: { inputTokens: number; outputTokens: number; costUsd: number };
  perPhase: Array<{
    orchestration: string;
    phaseName: string;
    runs: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
};

describe('every spend surface reports the same total for one run', () => {
  let restoreEnv: () => void;
  let mount: Mount;

  beforeAll(async () => {
    restoreEnv = pinTestEnv();
    const tmpRoot = await makeWorkspace('spend-agree');
    await writeOrchestration(tmpRoot, {
      name: ORCH,
      phases: [{ name: 'build', code: { source: "return 'ok';" } }],
    });
    mount = await mountServer(tmpRoot);

    const { status } = await postJson(`${mount.baseUrl}/api/runs`, {
      id: RUN_ID,
      orchestrationName: ORCH,
      status: 'done',
      startedAt: 1_000,
      endedAt: 1_400,
      events: EVENTS,
    });
    expect(status).toBe(200);
  });

  afterAll(async () => {
    await mount?.kill();
    restoreEnv?.();
  });

  it('`lib/spend` itself charges both attempts — the definition the rest agree with', () => {
    // The one assertion that owns the arithmetic. If the module stops
    // charging the failed attempt this reads 0.01 and goes red here, rather
    // than letting all four surfaces drift down together while still
    // "agreeing" with each other.
    const folded = foldSpend(EVENTS);
    expect(folded.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
    expect(folded.inputTokens).toBe(EXPECTED.inputTokens);
    expect(folded.outputTokens).toBe(EXPECTED.outputTokens);
  });

  it('/api/cost agrees — totals, the per-run row, and a row per attempt', async () => {
    const digest = await getJson<CostDigest>(`${mount.baseUrl}/api/cost`);
    expect(digest.totals.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
    expect(digest.totals.inputTokens).toBe(EXPECTED.inputTokens);
    expect(digest.totals.outputTokens).toBe(EXPECTED.outputTokens);

    const row = digest.perRun.find(r => r.id === RUN_ID);
    expect(row).toBeDefined();
    expect(row?.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
    expect(row?.inputTokens).toBe(EXPECTED.inputTokens);

    // Both attempts are visible, and the failed one says so — otherwise the
    // phase appears twice with no explanation of why.
    const phases = digest.perPhase[RUN_ID] ?? [];
    expect(phases.filter(p => p.phaseName === 'build')).toHaveLength(2);
    expect(phases.filter(p => p.failed === true)).toHaveLength(1);
    expect(
      phases.filter(p => p.phaseName === 'build').reduce((a, p) => a + p.costUsd, 0),
    ).toBeCloseTo(EXPECTED.costUsd, 10);
  });

  it('/api/observability agrees — totals, and its per-phase column adds up to them', async () => {
    const digest = await getJson<ObservabilityDigest>(
      `${mount.baseUrl}/api/observability`,
    );
    expect(digest.totals.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
    expect(digest.totals.inputTokens).toBe(EXPECTED.inputTokens);
    expect(digest.totals.outputTokens).toBe(EXPECTED.outputTokens);

    // Two figures in ONE response that disagree is the same defect one level
    // down: the rollup counted the failed attempt in `errors` but charged
    // nothing for it, so the column did not sum to the totals beside it.
    const row = digest.perPhase.find(
      p => p.orchestration === ORCH && p.phaseName === 'build',
    );
    expect(row).toBeDefined();
    expect(row?.runs).toBe(1); // one attempt completed
    expect(row?.errors).toBe(1); // one attempt failed
    expect(row?.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
    expect(
      digest.perPhase.reduce((a, p) => a + p.costUsd, 0),
    ).toBeCloseTo(digest.totals.costUsd, 10);
  });

  it('GET /api/runs/:id agrees (the per-run `costUsd` the store folds)', async () => {
    const run = await getJson<{ costUsd?: number }>(
      `${mount.baseUrl}/api/runs/${RUN_ID}`,
    );
    expect(run.costUsd).toBeCloseTo(EXPECTED.costUsd, 10);
  });

  it('none of them folds in the cumulative `cost` event', async () => {
    // The guard that makes the agreement meaningful: four surfaces could all
    // read 0.04 and still agree. `cost` carries the run's running total, so
    // adding it would exactly double every figure here.
    const digest = await getJson<CostDigest>(`${mount.baseUrl}/api/cost`);
    expect(digest.totals.costUsd).toBeLessThan(0.03);
  });
});
