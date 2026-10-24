/**
 * Tests for the shared child-node walker (lib/node-walk.ts) — the single
 * source of truth for "which fields of a Node hold child Nodes" — and for the
 * walkers refactored onto it.
 *
 * The headline test is the SCHEMA PARITY guard: it derives every
 * child-Node-carrying property path from the published orchestration JSON
 * schema (the same artifact external tools consume), plants a uniquely-named
 * child at each derived path, and asserts `childNodesOf` finds all of them.
 * This is what makes the walker drift-proof: adding a future composite kind
 * to the schema without teaching `childNodesOf` about it fails HERE, instead
 * of silently punching a hole in every policy/validation walk built on it
 * (exactly how `switch` cases escaped the sandbox walk and `onStall.recover`
 * escaped the code.run preflight).
 */

import fs from 'node:fs';
import path from 'node:path';
import { childNodesOf } from '../src/lib/node-walk';
import { collectNodeNames } from '../src/lib/runStatus';
import { orchestrationUsesCodeRun } from '../src/llm/executor';
import {
  collectAgentPaths,
  collectCredentialRefs,
  collectSubflowRefs,
} from '../src/validate';
import type { Node } from '../src/types';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../schema/orchestration.schema.json',
);

type SchemaObj = Record<string, any>;

function loadSchema(): SchemaObj {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Does this property schema hold child Node(s) — directly ($ref), as an
 *  array (items.$ref), or as a name→node record (additionalProperties.$ref)?
 *  Returns the shape so the fixture builder knows how to plant a child. */
function nodeShapeOf(
  prop: SchemaObj | undefined,
): 'single' | 'array' | 'record' | null {
  if (!prop || typeof prop !== 'object') return null;
  const refsNode = (s: SchemaObj | undefined): boolean =>
    !!s && typeof s === 'object' && String(s.$ref ?? '').endsWith('/node');
  if (refsNode(prop)) return 'single';
  if (refsNode(prop.items)) return 'array';
  if (refsNode(prop.additionalProperties)) return 'record';
  return null;
}

/** Every path (relative to a node) at which the SCHEMA says a child Node can
 *  live. Top-level node properties plus one level of $ref-ed body defs
 *  (loopBody.body, switchBody.cases, onStallPolicy.recover, …) — every
 *  composite the schema has ever grown nests at most one def deep. */
function schemaChildPaths(): { path: string[]; shape: string }[] {
  const schema = loadSchema();
  const defs: SchemaObj = schema.$defs ?? {};
  const nodeProps: SchemaObj = defs.node?.properties ?? {};
  const out: { path: string[]; shape: string }[] = [];
  for (const [propName, propSchema] of Object.entries<SchemaObj>(nodeProps)) {
    const direct = nodeShapeOf(propSchema);
    if (direct) {
      out.push({ path: [propName], shape: direct });
      continue;
    }
    // A body def one $ref away (e.g. `loop` → `$defs/loopBody`): scan ITS
    // properties for node-carrying fields.
    const ref = String(propSchema?.$ref ?? '');
    const m = ref.match(/#\/\$defs\/(\w+)$/);
    if (!m) continue;
    const bodyProps: SchemaObj = defs[m[1]]?.properties ?? {};
    for (const [subName, subSchema] of Object.entries<SchemaObj>(bodyProps)) {
      const shape = nodeShapeOf(subSchema);
      if (shape) out.push({ path: [propName, subName], shape });
    }
  }
  return out;
}

/** Build a Node fixture with a uniquely-named child planted at each derived
 *  schema path; returns the fixture and the planted child names. */
function buildFixture(): { fixture: Node; planted: string[] } {
  const fixture: SchemaObj = { name: 'root' };
  const planted: string[] = [];
  for (const { path: p, shape } of schemaChildPaths()) {
    const childName = `child:${p.join('.')}`;
    planted.push(childName);
    const child = { name: childName };
    const value =
      shape === 'array'
        ? [child]
        : shape === 'record'
          ? { onlyKey: child }
          : child;
    if (p.length === 1) {
      fixture[p[0]] = value;
    } else {
      fixture[p[0]] = { ...(fixture[p[0]] ?? {}), [p[1]]: value };
    }
  }
  return { fixture: fixture as Node, planted };
}

describe('childNodesOf ⇄ schema parity (drift-proofing)', () => {
  it('the schema declares the expected child-carrying paths (sanity)', () => {
    const paths = schemaChildPaths().map(p => p.path.join('.'));
    // The known universe today. If this grows, childNodesOf must grow with it
    // — the next test enforces that mechanically; this one just documents it.
    expect(paths.sort()).toEqual(
      [
        'phases',
        'parallel',
        'converge',
        'onError',
        'loop.body',
        'map.body',
        'route.branches',
        'route.default',
        'switch.cases',
        'switch.default',
        'onStall.recover',
      ].sort(),
    );
  });

  it('childNodesOf returns a child planted at EVERY schema child path', () => {
    const { fixture, planted } = buildFixture();
    const found = childNodesOf(fixture).map(c => c.name);
    for (const name of planted) {
      expect(found).toContain(name);
    }
    // And nothing else — no duplicates, no phantom children.
    expect(found.sort()).toEqual(planted.sort());
  });

  it('reference-style bodies contribute NO children (subflow / agents / conversation)', () => {
    const node: Node = {
      name: 'refs',
      subflow: 'another-orchestration',
      agents: ['agents/x.md', 'agents/y.md'],
      conversation: { participants: ['agents/x.md'], rounds: 2 },
    };
    expect(childNodesOf(node)).toEqual([]);
  });
});

// ── Regression: the walkers that had drifted, now on the shared walk ────────

describe('walkers refactored onto childNodesOf', () => {
  it('orchestrationUsesCodeRun detects a code.run inside onStall.recover', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'work',
          agent: 'agents/a.md',
          onStall: {
            recover: { name: 'fix', code: { run: './relaunch-dependency.sh' } },
          },
        },
      ],
    };
    expect(orchestrationUsesCodeRun(root)).toBe(true);
  });

  it('orchestrationUsesCodeRun still detects a code.run inside switch cases', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'branch',
          switch: {
            cases: { yes: { name: 'go', code: { run: 'echo hi' } } },
          },
        },
      ],
    };
    expect(orchestrationUsesCodeRun(root)).toBe(true);
  });

  it('collectNodeNames includes onStall.recover subtree names', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'work',
          agent: 'agents/a.md',
          onStall: { recover: { name: 'fix-it', agent: 'agents/f.md' } },
        },
      ],
    };
    expect(collectNodeNames(root)).toEqual(['flow', 'work', 'fix-it']);
  });

  it('collectAgentPaths sees agents inside switch cases and onStall.recover', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'branch',
          switch: {
            cases: { a: { name: 'inA', agent: 'agents/in-case.md' } },
            default: { name: 'inD', agent: 'agents/in-default.md' },
          },
          onStall: {
            recover: { name: 'fix', agent: 'agents/in-recover.md' },
          },
        },
      ],
    };
    expect(collectAgentPaths(root)).toEqual([
      'agents/in-case.md',
      'agents/in-default.md',
      'agents/in-recover.md',
    ]);
  });

  it('collectCredentialRefs sees credentials inside switch cases and onStall.recover', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'branch',
          switch: {
            cases: { a: { name: 'inA', agent: 'agents/a.md', credential: 'ticketing' } },
          },
          onStall: {
            recover: {
              name: 'fix',
              agent: 'agents/f.md',
              credentials: ['artifact-store'],
            },
          },
        },
      ],
    };
    expect(collectCredentialRefs(root)).toEqual(['artifact-store', 'ticketing']);
  });

  it('collectSubflowRefs sees subflows inside switch cases and onStall.recover (cycle detection input)', () => {
    const root: Node = {
      name: 'flow',
      phases: [
        {
          name: 'branch',
          switch: {
            cases: { a: { name: 'inA', subflow: 'sub-in-case' } },
          },
          onStall: {
            recover: { name: 'fix', subflow: 'sub-in-recover' },
          },
        },
      ],
    };
    expect(collectSubflowRefs(root)).toEqual(['sub-in-case', 'sub-in-recover']);
  });
});
