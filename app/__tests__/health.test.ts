/**
 * Health / capability endpoint backing logic.
 *
 * These tests pin the RESPONSE SHAPE and the cheap signals WITHOUT a live
 * server, a real store, or spawning an agent — by exercising the pure /
 * injectable `buildHealth` builder plus the small `codeRunEnabled` /
 * `probeStore` / agent-tools-cache helpers directly. The expensive empirical
 * agent probe is a documented seam (`probeAgentTools`) that returns 'unknown'
 * until wired, so it stays safe to call here.
 */

import {
  buildHealth,
  codeRunEnabled,
  probeStore,
  probeAgentTools,
  getCachedAgentTools,
  setCachedAgentTools,
  type StoreStatus,
} from '../src/server/health';
import type { RunStore } from '../src/server/run-store';

/** Minimal store doubles — only the members the health path touches. */
function workingStore(): Pick<RunStore, 'listRuns'> {
  return { listRuns: async () => [] };
}
function brokenStore(): Pick<RunStore, 'listRuns'> {
  return {
    listRuns: async () => {
      throw new Error('connection refused');
    },
  };
}

describe('codeRunEnabled', () => {
  const ORIGINAL = process.env.SAMMY_ALLOW_CODE_RUN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SAMMY_ALLOW_CODE_RUN;
    else process.env.SAMMY_ALLOW_CODE_RUN = ORIGINAL;
  });

  it("is false when the env flag is unset", () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    expect(codeRunEnabled()).toBe(false);
  });

  it("is true for '1' and 'true', false for anything else", () => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    expect(codeRunEnabled()).toBe(true);
    process.env.SAMMY_ALLOW_CODE_RUN = 'true';
    expect(codeRunEnabled()).toBe(true);
    process.env.SAMMY_ALLOW_CODE_RUN = '0';
    expect(codeRunEnabled()).toBe(false);
    process.env.SAMMY_ALLOW_CODE_RUN = 'yes';
    expect(codeRunEnabled()).toBe(false);
  });
});

describe('probeStore', () => {
  it("resolves 'ok' when listRuns succeeds", async () => {
    await expect(probeStore(workingStore())).resolves.toBe('ok');
  });

  it("resolves 'unreachable' when listRuns throws (never rethrows)", async () => {
    await expect(probeStore(brokenStore())).resolves.toBe('unreachable');
  });
});

describe('buildHealth', () => {
  it("returns the documented shape", () => {
    const h = buildHealth({
      backend: 'sqlite',
      store: 'ok',
      codeRun: false,
    });
    expect(h).toEqual({
      status: 'ok',
      backend: 'sqlite',
      capabilities: { codeRun: false, store: 'ok', agentTools: 'unknown' },
      ts: expect.any(Number),
    });
  });

  it("status is 'ok' when the store is ok", () => {
    expect(
      buildHealth({ backend: 'sqlite', store: 'ok', codeRun: false }).status,
    ).toBe('ok');
  });

  it("status is 'degraded' when the store is unreachable", () => {
    const h = buildHealth({
      backend: 'postgres',
      store: 'unreachable',
      codeRun: true,
    });
    expect(h.status).toBe('degraded');
    expect(h.capabilities.store).toBe('unreachable');
    expect(h.backend).toBe('postgres');
  });

  it("codeRun reflects the passed signal", () => {
    expect(
      buildHealth({ backend: 'sqlite', store: 'ok', codeRun: true })
        .capabilities.codeRun,
    ).toBe(true);
    expect(
      buildHealth({ backend: 'sqlite', store: 'ok', codeRun: false })
        .capabilities.codeRun,
    ).toBe(false);
  });

  it("agentTools defaults to 'unknown' when no probe result is supplied", () => {
    expect(
      buildHealth({ backend: 'sqlite', store: 'ok', codeRun: false })
        .capabilities.agentTools,
    ).toBe('unknown');
  });

  it("agentTools reflects a supplied (cached) probe result", () => {
    const statuses = ['ok', 'failed', 'unknown'] as const;
    for (const s of statuses) {
      expect(
        buildHealth({
          backend: 'sqlite',
          store: 'ok',
          codeRun: false,
          probedAgentTools: s,
        }).capabilities.agentTools,
      ).toBe(s);
    }
  });

  it("integrates with probeStore end-to-end (working + broken store)", async () => {
    const okStore: StoreStatus = await probeStore(workingStore());
    expect(
      buildHealth({ backend: 'sqlite', store: okStore, codeRun: false }).status,
    ).toBe('ok');

    const badStore: StoreStatus = await probeStore(brokenStore());
    expect(
      buildHealth({ backend: 'sqlite', store: badStore, codeRun: false })
        .status,
    ).toBe('degraded');
  });
});

describe('agent-tools probe cache (safe seam)', () => {
  afterEach(() => setCachedAgentTools(undefined));

  it("getCachedAgentTools is 'unknown' before any probe", () => {
    setCachedAgentTools(undefined);
    expect(getCachedAgentTools()).toBe('unknown');
  });

  it("probeAgentTools returns 'unknown' (documented seam, no agent spawned)", async () => {
    setCachedAgentTools(undefined);
    await expect(probeAgentTools()).resolves.toBe('unknown');
  });

  it("a cached result is returned by both the cache reader and the probe", async () => {
    setCachedAgentTools('ok');
    expect(getCachedAgentTools()).toBe('ok');
    await expect(probeAgentTools()).resolves.toBe('ok');
    setCachedAgentTools('failed');
    await expect(probeAgentTools()).resolves.toBe('failed');
  });
});
