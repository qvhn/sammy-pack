/**
 * POST /api/preview — the HTTP surface over the symbolic dry-run walker.
 *
 * Boots the REAL server (mountSammyApi on connect + http.Server, real sqlite
 * store, real workspace files) via the lifecycle harness, then exercises the
 * preview endpoint end-to-end: the same walker + text renderer the in-repo
 * `sammy-cli preview` command uses, resolved against the same workspace
 * context the run-start path loads. Pure analysis — the suite also pins that
 * no run row is ever created by a preview.
 */

import {
  listRuns,
  makeWorkspace,
  mountServer,
  pinTestEnv,
  postJson,
  writeOrchestration,
  type Mount,
} from './lifecycle-harness.helpers';

type PreviewFindingOut = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  phase?: string;
};
type PreviewNodeOut = {
  name: string;
  kind: string;
  children: PreviewNodeOut[];
  action?: { verb: string; text: string };
};
type PreviewResponse = {
  findings: PreviewFindingOut[];
  tree: PreviewNodeOut[];
  rendered: string;
};

let restoreEnv: () => void;
let mount: Mount;

beforeAll(async () => {
  restoreEnv = pinTestEnv();
  const tmpRoot = await makeWorkspace('preview-api');

  // Clean two-phase code.source pipeline: no vars, no code.run, no unbound
  // refs — lints to zero findings.
  await writeOrchestration(tmpRoot, {
    name: 'preview-mini',
    phases: [
      { name: 'shout', code: { source: 'return String(input).toUpperCase()' } },
      { name: 'wrap', code: { source: 'return input + "!"' } },
    ],
  });

  // Var-consuming code.run phase: exercises vars overrides in the body and
  // the lint toggle (code.run carries a deliberate heads-up warning).
  await writeOrchestration(tmpRoot, {
    name: 'preview-vars',
    vars: { env: 'dev' },
    phases: [{ name: 'ship', code: { run: 'deploy.sh ${env}' } }],
  });

  // Subflow parent: proves the endpoint hands the walker the workspace's
  // sibling orchestrations (loadRunContext's set), so subflows expand.
  await writeOrchestration(tmpRoot, {
    name: 'preview-parent',
    phases: [{ name: 'delegate', subflow: 'preview-mini' }],
  });

  mount = await mountServer(tmpRoot);
});

afterAll(async () => {
  await mount.kill();
  restoreEnv();
});

describe('POST /api/preview', () => {
  test('a clean code-phase orchestration → findings [], tree + rendered text', async () => {
    const { status, body } = await postJson<PreviewResponse>(
      `${mount.baseUrl}/api/preview`,
      { orchestrationName: 'preview-mini' },
    );
    expect(status).toBe(200);
    expect(body.findings).toEqual([]);
    expect(typeof body.rendered).toBe('string');
    expect(body.rendered).toContain('preview  preview-mini');
    expect(body.rendered).toContain('shout');
    expect(body.rendered).toContain('wrap');
    expect(Array.isArray(body.tree)).toBe(true);
    expect(body.tree.map(n => n.name)).toEqual(['shout', 'wrap']);
    expect(body.tree[0].kind).toBe('code');
  });

  test('is pure — a preview creates no run row', async () => {
    await postJson(`${mount.baseUrl}/api/preview`, {
      orchestrationName: 'preview-mini',
    });
    expect(await listRuns(mount.baseUrl)).toEqual([]);
  });

  test('vars override resolves into the plan; default lint flags code.run', async () => {
    const { status, body } = await postJson<PreviewResponse>(
      `${mount.baseUrl}/api/preview`,
      { orchestrationName: 'preview-vars', vars: { env: 'stg' } },
    );
    expect(status).toBe(200);
    expect(body.rendered).toContain('deploy.sh stg');
    const codeRun = body.findings.find(f => f.code === 'code-run');
    expect(codeRun).toBeDefined();
    expect(codeRun!.severity).toBe('warning');
    expect(codeRun!.phase).toBe('ship');
  });

  test('lint:false suppresses the lint findings (walker findings only)', async () => {
    const { status, body } = await postJson<PreviewResponse>(
      `${mount.baseUrl}/api/preview`,
      { orchestrationName: 'preview-vars', lint: false },
    );
    expect(status).toBe(200);
    expect(body.findings.some(f => f.code === 'code-run')).toBe(false);
    // Without an override the orchestration's own var resolves.
    expect(body.rendered).toContain('deploy.sh dev');
  });

  test('subflows expand against the workspace orchestration set', async () => {
    const { status, body } = await postJson<PreviewResponse>(
      `${mount.baseUrl}/api/preview`,
      { orchestrationName: 'preview-parent' },
    );
    expect(status).toBe(200);
    const delegate = body.tree[0];
    expect(delegate.kind).toBe('subflow');
    // The child orchestration's phases are inlined — not rendered symbolically.
    const childNames = delegate.children.map(c => c.name);
    expect(childNames).toContain('shout');
    expect(body.findings.some(f => f.code === 'missing-subflow')).toBe(false);
  });

  test('unknown orchestration → 404', async () => {
    const { status } = await postJson(`${mount.baseUrl}/api/preview`, {
      orchestrationName: 'no-such-orchestration',
    });
    expect(status).toBe(404);
  });

  test('bad bodies → 400', async () => {
    // Invalid JSON.
    const raw = await fetch(`${mount.baseUrl}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(raw.status).toBe(400);

    // Missing / unsafe orchestrationName.
    expect((await postJson(`${mount.baseUrl}/api/preview`, {})).status).toBe(400);
    expect(
      (
        await postJson(`${mount.baseUrl}/api/preview`, {
          orchestrationName: '../escape',
        })
      ).status,
    ).toBe(400);

    // Wrong-typed optionals.
    expect(
      (
        await postJson(`${mount.baseUrl}/api/preview`, {
          orchestrationName: 'preview-mini',
          vars: { env: 5 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mount.baseUrl}/api/preview`, {
          orchestrationName: 'preview-mini',
          depth: -1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postJson(`${mount.baseUrl}/api/preview`, {
          orchestrationName: 'preview-mini',
          lint: 'yes',
        })
      ).status,
    ).toBe(400);
  });

  test('non-POST → 405', async () => {
    const res = await fetch(`${mount.baseUrl}/api/preview`);
    expect(res.status).toBe(405);
  });
});
