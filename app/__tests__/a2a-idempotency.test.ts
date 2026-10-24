import { A2aIdempotencyCache } from '../src/server/a2a-idempotency';

describe('A2aIdempotencyCache (receiver-side message/send dedupe)', () => {
  const NOW = 1_800_000_000_000;

  it('returns the recorded run id for a repeated key', () => {
    const c = new A2aIdempotencyCache();
    expect(c.get('flow', 'k1', NOW)).toBeNull();
    c.record('flow', 'k1', 'run-1', NOW);
    expect(c.get('flow', 'k1', NOW)).toBe('run-1');
  });

  it('scopes keys per orchestration', () => {
    const c = new A2aIdempotencyCache();
    c.record('flow-a', 'k1', 'run-a', NOW);
    expect(c.get('flow-b', 'k1', NOW)).toBeNull();
    expect(c.get('flow-a', 'k1', NOW)).toBe('run-a');
  });

  it('expires entries after the TTL', () => {
    const c = new A2aIdempotencyCache(1000);
    c.record('flow', 'k1', 'run-1', NOW);
    expect(c.get('flow', 'k1', NOW + 999)).toBe('run-1');
    expect(c.get('flow', 'k1', NOW + 1001)).toBeNull();
  });

  it('evicts when over capacity instead of growing unbounded', () => {
    const c = new A2aIdempotencyCache(60_000, 3);
    c.record('flow', 'k1', 'r1', NOW);
    c.record('flow', 'k2', 'r2', NOW);
    c.record('flow', 'k3', 'r3', NOW);
    c.record('flow', 'k4', 'r4', NOW); // sweep evicts the oldest live entry
    expect(c.get('flow', 'k4', NOW)).toBe('r4');
    expect(c.get('flow', 'k1', NOW)).toBeNull();
  });
});
