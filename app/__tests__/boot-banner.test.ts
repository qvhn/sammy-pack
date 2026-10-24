/**
 * Boot config echo. A server restart without SAMMY_ALLOW_CODE_RUN once
 * made EVERY scheduled run halt at preflight — env-coupled correctness with
 * nothing echoed at boot. The mount now prints one structured banner with the
 * effective config (code.run flag, store backend + db size, connections /
 * budget files, gate TTL, retention, registered trigger counts) plus a
 * WARNING per triggered orchestration that is already doomed by the code.run
 * flag. These tests pin the banner keys and the warning's firing conditions.
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import connect from 'connect';
import * as cron from 'node-cron';
import { mountSammyApi } from '../sammy-pack-api';
import { SqliteRunStore } from '../src/server/db';
import { _resetEnvWarningsForTests } from '../src/server/env';

/** The mounts here register cron triggers with node-cron, whose task timer
 *  is NOT unref'd — when jest runs this suite in-band, a live task would
 *  keep the process open forever. Destroy every scheduled task at teardown
 *  (same defensive shape as the mount's own leak sweeper). */
function destroyAllCronTasks(): void {
  const getTasks = (
    cron as unknown as { getTasks?: () => Map<string, { destroy?: () => void }> }
  ).getTasks;
  if (typeof getTasks !== 'function') return;
  for (const task of getTasks().values()) {
    try {
      task.destroy?.();
    } catch {
      /* already destroyed */
    }
  }
}

describe('boot config banner', () => {
  let server: http.Server;
  let tmpRoot: string;
  let store: SqliteRunStore;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'SAMMY_ALLOW_CODE_RUN',
    'SAMMY_GATE_TTL_HOURS',
    'SAMMY_RUN_RETENTION_DAYS',
    'SAMMY_CONNECTIONS_FILE',
    'SAMMY_DISABLE_INPROCESS_WORKER',
    'DATABASE_URL',
    // The auth / posture lines read all of these; pin them per test so the
    // ambient shell cannot change what the banner says.
    'SAMMY_API_TOKEN',
    'SAMMY_REQUIRE_AUTH_READS',
    'SAMMY_JWT_SECRET',
    'SAMMY_JWT_PUBLIC_KEY',
    'SAMMY_JWKS_URI',
    'SAMMY_BIND_HOST',
    'SAMMY_METRICS_PUBLIC',
    'SAMMY_IMPORT_ROOTS',
    'SAMMY_LLM_STREAM_TOOLS',
    'SAMMY_LLM_STREAM_TOOL_ALLOWLIST',
    'SAMMY_REQUIRE_SIGNED_TRIGGERS',
  ];
  const POSTURE_KEYS = ENV_KEYS.slice(ENV_KEYS.indexOf('SAMMY_API_TOKEN'));

  beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.SAMMY_DISABLE_INPROCESS_WORKER = '1';
    delete process.env.DATABASE_URL;
    for (const k of POSTURE_KEYS) delete process.env[k];
    // The banner echoes the CONNECTIONS file path — pin it to the default
    // (<root>/credentials.json) regardless of the ambient environment.
    delete process.env.SAMMY_CONNECTIONS_FILE;
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sammy-banner-'));
    await fs.mkdir(path.join(tmpRoot, 'examples'), { recursive: true });
    // The [config] warnings are once-per-variable for the process; reset so
    // each mount's warnings are its own.
    _resetEnvWarningsForTests();
    // Quiet + capturable console during the mount.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    destroyAllCronTasks();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function mount(): Promise<void> {
    store = new SqliteRunStore(tmpRoot);
    await store.init();
    const app = connect();
    server = http.createServer(app);
    await mountSammyApi(
      {
        middlewares: app,
        config: { root: path.join(tmpRoot, 'app', 'web') },
        httpServer: server,
      },
      { store },
    );
    await new Promise<void>(resolve => server.listen(0, resolve));
  }

  /** The single boot-config banner (one console.log call, newline-joined). */
  function banner(): string {
    const call = logSpy.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('boot config:'),
    );
    expect(call).toBeDefined();
    return call![0] as string;
  }

  function allWarns(): string {
    return warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  it('echoes every effective-config key once, in one structured banner', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    process.env.SAMMY_GATE_TTL_HOURS = '12';
    process.env.SAMMY_RUN_RETENTION_DAYS = '30';
    // One registered cron so the trigger counts have something to say.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'nightly.json'),
      JSON.stringify({
        name: 'nightly',
        triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
        phases: [{ name: 'p', code: { source: "return 'x'" } }],
      }),
      'utf8',
    );
    await mount();

    const b = banner();
    // code.run flag — the exact failure this banner exists for.
    expect(b).toContain('code.run: disabled (SAMMY_ALLOW_CODE_RUN / SAMMY_CODE_RUN_ALLOW)');
    // Store backend, its file, and its size.
    expect(b).toContain('store: sqlite');
    expect(b).toContain('runs.db');
    expect(b).toMatch(/\(\d+(\.\d+)? MB\)/);
    // Workspace files, with existence.
    expect(b).toMatch(/connections file: .*credentials\.json \((exists|missing)\)/);
    expect(b).toMatch(/budget file: .*budget\.json \((exists|missing)\)/);
    // The two new sweeps' effective settings.
    expect(b).toContain('gate TTL: 12.00h, action=notify');
    expect(b).toContain('retention: 30 day(s)');
    // Registered trigger counts by kind.
    expect(b).toMatch(
      /triggers: 0 webhook, 1 cron, 0 polling, 0 event, 0 deployment, 0 queue/,
    );
  });

  it('reports disabled/off states honestly', async () => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    process.env.SAMMY_GATE_TTL_HOURS = '0';
    delete process.env.SAMMY_RUN_RETENTION_DAYS;
    await mount();

    const b = banner();
    expect(b).toContain('code.run: ENABLED, unrestricted (SAMMY_ALLOW_CODE_RUN)');
    expect(b).toContain('gate TTL: disabled (SAMMY_GATE_TTL_HOURS=0)');
    expect(b).toContain('retention: OFF (SAMMY_RUN_RETENTION_DAYS unset)');
  });

  it('warns per cron/webhook orchestration that uses code.run while disabled', async () => {
    delete process.env.SAMMY_ALLOW_CODE_RUN;
    // Doomed: fires unattended (cron + webhook) AND uses code.run (nested,
    // to prove the shared executor walker — not a shallow check — decides).
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'doomed.json'),
      JSON.stringify({
        name: 'doomed',
        triggers: [
          { kind: 'cron', expr: '0 9 * * *' },
          { kind: 'webhook', path: 'doomed-hook', method: 'POST' },
        ],
        phases: [
          {
            name: 'wrap',
            loop: {
              body: { name: 'shell', code: { run: 'echo hi' } },
              maxIterations: 1,
            },
          },
        ],
      }),
      'utf8',
    );
    // Control 1: scheduled but NO code.run → silent.
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'fine.json'),
      JSON.stringify({
        name: 'fine',
        triggers: [{ kind: 'cron', expr: '0 8 * * *' }],
        phases: [{ name: 'p', code: { source: "return 'ok'" } }],
      }),
      'utf8',
    );
    // Control 2: uses code.run but only fired MANUALLY → silent (a human at
    // the button sees the preflight error themselves).
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'manual.json'),
      JSON.stringify({
        name: 'manual',
        phases: [{ name: 'shell', code: { run: 'echo hi' } }],
      }),
      'utf8',
    );
    await mount();

    const warns = allWarns();
    expect(warns).toContain('scheduled orchestration "doomed"');
    expect(warns).toContain('will halt at preflight: code.run disabled');
    expect(warns).toContain('cron');
    expect(warns).toContain('webhook');
    expect(warns).not.toContain('"fine"');
    expect(warns).not.toContain('"manual"');
  });

  it('prints the auth posture even when NOTHING is configured — the open server is the loud one', async () => {
    // This posture used to print no auth line at all: the gate logged only
    // when SAMMY_API_TOKEN was set, so the most dangerous configuration was
    // the silent one.
    await mount();
    const b = banner();
    expect(b).toContain('auth: SAMMY_API_TOKEN UNSET');
    expect(b).toContain('reads OPEN (set SAMMY_REQUIRE_AUTH_READS=1');
    expect(b).toContain('root /metrics open');
    expect(b).toContain('bind host (SAMMY_BIND_HOST unset');
    expect(b).toContain('identity: client-supplied X-Sammy-User header (no JWT verifier');
    expect(b).toMatch(/import roots: .*\(workspace only — SAMMY_IMPORT_ROOTS unset\)/);
    expect(b).toContain('llm stream tools: UNRESTRICTED');
    expect(b).toContain('signed triggers: optional');
  });

  it('reports the hardened posture, naming each setting', async () => {
    process.env.SAMMY_API_TOKEN = 'banner-token';
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    process.env.SAMMY_JWT_SECRET = 'banner-secret';
    process.env.SAMMY_BIND_HOST = '0.0.0.0';
    process.env.SAMMY_IMPORT_ROOTS = tmpRoot;
    process.env.SAMMY_LLM_STREAM_TOOLS = 'off';
    process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS = '1';
    await mount();
    const b = banner();
    expect(b).toContain('auth: SAMMY_API_TOKEN set');
    expect(b).toContain('reads GATED (SAMMY_REQUIRE_AUTH_READS=1)');
    expect(b).toContain('root /metrics gated like /api reads');
    expect(b).toContain('bind host 0.0.0.0');
    expect(b).toContain('identity: verified JWT (HS256)');
    expect(b).toContain('import roots:');
    expect(b).toContain('(SAMMY_IMPORT_ROOTS)');
    expect(b).toContain('llm stream tools: OFF');
    expect(b).toContain('signed triggers: REQUIRED');
    // The token itself never appears in the log.
    expect(b).not.toContain('banner-token');
    expect(b).not.toContain('banner-secret');
  });

  it('describes the combined posture: token OR verified JWT', async () => {
    // "token + verifier" used to be unsatisfiable (no string is both); the
    // banner now says what the composed gate actually accepts.
    process.env.SAMMY_API_TOKEN = 'banner-token';
    process.env.SAMMY_JWT_SECRET = 'banner-secret';
    await mount();
    const b = banner();
    expect(b).toContain('mutating /api routes require the bearer token OR a verified JWT');
    expect(b).toContain('identity: verified JWT (HS256)');
  });

  it('accepts the ordinary boolean spellings for the REQUIRE_* flags, and fails them closed on garbage', async () => {
    process.env.SAMMY_API_TOKEN = 'banner-token';
    process.env.SAMMY_REQUIRE_AUTH_READS = 'true';
    process.env.SAMMY_REQUIRE_SIGNED_TRIGGERS = 'maybe';
    await mount();
    const b = banner();
    // `=== '1'` used to make `true` mean OFF.
    expect(b).toContain('reads GATED (SAMMY_REQUIRE_AUTH_READS=1)');
    // Garbage on a refuse-flag counts as ON, loudly.
    expect(b).toContain('signed triggers: REQUIRED');
    expect(allWarns()).toContain('SAMMY_REQUIRE_SIGNED_TRIGGERS="maybe"');
    expect(allWarns()).toContain('ENABLED');
  });

  it('calls out reads that are gated in name only, and a public metrics opt-out', async () => {
    process.env.SAMMY_REQUIRE_AUTH_READS = '1';
    process.env.SAMMY_METRICS_PUBLIC = '1';
    process.env.SAMMY_LLM_STREAM_TOOL_ALLOWLIST = 'Read,Grep';
    await mount();
    const b = banner();
    expect(b).toContain('reads GATED IN NAME ONLY');
    expect(b).toContain('root /metrics PUBLIC (SAMMY_METRICS_PUBLIC=1)');
    expect(b).toContain('llm stream tools: allowlisted: Read,Grep');
  });

  it('stays silent about code.run doom when the flag is set', async () => {
    process.env.SAMMY_ALLOW_CODE_RUN = '1';
    await fs.writeFile(
      path.join(tmpRoot, 'examples', 'doomed.json'),
      JSON.stringify({
        name: 'doomed',
        triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
        phases: [{ name: 'shell', code: { run: 'echo hi' } }],
      }),
      'utf8',
    );
    await mount();
    expect(allWarns()).not.toContain('will halt at preflight');
  });
});
