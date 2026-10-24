/**
 * Machine-independent test environment (setupFilesAfterEnv — runs before
 * every test FILE's suites).
 *
 * The global agent-dispatch semaphore sizes itself from the host CPU count
 * (SAMMY_MAX_CONCURRENT_AGENTS, else CPU-derived). On a 2-core CI runner
 * that meant TWO slots: suites that legitimately fan out 3–4 parallel
 * agents queued on the semaphore and blew Jest's 5s default timeout, and
 * the map-concurrency test observed a peak of 2 instead of its all-at-once
 * fan-out — 12 CI-only failures that never reproduced on a many-core
 * laptop (repro: SAMMY_MAX_CONCURRENT_AGENTS=2 npx jest --runInBand).
 * Pin the pool to a size no suite's fan-out exceeds. A suite that
 * deliberately tests slot exhaustion resizes the semaphore itself
 * (agentSlots.setLimit) inside its own hooks, which run after this and win.
 */
import { agentSlots } from './src/llm/concurrency';

agentSlots.setLimit(8);
