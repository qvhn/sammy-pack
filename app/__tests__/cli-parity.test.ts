import fs from 'node:fs';
import path from 'node:path';

/**
 * Parity contract between the schema, the web executor, and the CLI skill.
 *
 * The orchestration JSON is the single source of truth that BOTH execution
 * surfaces consume — the web executor at `app/src/llm/executor.ts` and the
 * CLI/Claude-Code skill at `.claude/skills/sammy-pack/SKILL.md`. If a new
 * schema property or body kind ships in one place but not the other, runs
 * silently diverge: the same JSON behaves differently depending on whether
 * it's launched from the web UI or the CLI.
 *
 * This test enforces that every schema-declared node property + body kind:
 *   - is referenced in executor.ts (real runtime handling), AND
 *   - is mentioned in SKILL.md (LLM-readable instructions for the CLI agent)
 *
 * If you add a property to the schema, both files must catch up — or you
 * must add it to the allowlist below with a comment explaining why.
 *
 * Recipe when this test fails:
 *   1) Add handling in `app/src/llm/executor.ts` for the new field.
 *   2) Document it in `.claude/skills/sammy-pack/SKILL.md`.
 *   3) Re-run tests.
 *
 * To intentionally skip a field (e.g. UI-only metadata): add it to
 * `TRIVIAL_PROPS` (always-skipped) or `INTENTIONALLY_UNIMPLEMENTED` (skipped
 * with a written reason).
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'schema/orchestration.schema.json');
const SKILL_PATH = path.join(REPO_ROOT, '.claude/skills/sammy-pack/SKILL.md');
const EXECUTOR_PATH = path.join(REPO_ROOT, 'app/src/llm/executor.ts');

// Trivial fields don't need explicit handling — they're either display-only
// or pure UI metadata. Document why each is here so future-you can defend it.
const TRIVIAL_PROPS = new Set<string>([
  'name',         // every node has a name; not a feature, just an identifier
  'description',  // free-text doc shown in the UI / read by the agent in context
  '_layout',      // UI-only positions for the Graph editor; CLI ignores
  '__origin',     // runtime-only provenance (symlink=imported / file=shipped)
                  // set by the loader for subflow precedence; never authored,
                  // never persisted — nothing for a CLI user to write or read
]);

// Fields declared in the schema but intentionally not enforced at runtime.
// Add a comment explaining the policy decision. (Currently empty —
// `input` / `output` USED to live here as "documentation only", but the
// web executor now enforces inline-schema contracts at phase boundaries
// and SKILL.md instructs the CLI to do the same best-effort check, so
// they're held to the normal parity bar.)
const INTENTIONALLY_UNIMPLEMENTED = new Map<string, string>([
  [
    'triggers',
    'Server-boundary feature, not an executor concern. Webhook / cron ' +
      'triggers are registered at dev-server boot in sammy-pack-api.ts; ' +
      'the executor itself has no notion of them. From the CLI walk, ' +
      "SKILL.md tells the agent to note their presence but they don't " +
      "affect the run that's being driven from the CLI loop.",
  ],
  [
    'inputs',
    'Server-boundary feature. The input resolver (input-resolver.ts) + the ' +
      "run API resolve an orchestration's declared inputs (Jira / URL / doc) " +
      'to content BEFORE the executor runs; the executor only consumes the ' +
      'resolved values via resolvedInputs and seeds them into state as ' +
      '${name}. Like triggers, the declaration itself is not an executor ' +
      'concern.',
  ],
  [
    'notify',
    'Server-boundary feature, not an executor concern. notify.onTerminal is ' +
      "an outbound webhook fired from the run's terminal hook in " +
      'sammy-pack-api.ts (buildTerminalHook) once the run reaches a terminal ' +
      'status — the executor itself never sees it. Like triggers, the ' +
      'declaration is documented in SKILL.md so a CLI walk can note it, but ' +
      "it doesn't affect the run being driven from the CLI loop.",
  ],
]);

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const allProps: string[] = Object.keys(schema.$defs.node.properties);
const bodyKinds: string[] = schema.$defs.node.oneOf.map(
  (o: { required: string[] }) => o.required[0],
);

const skill = fs.readFileSync(SKILL_PATH, 'utf8').toLowerCase();
const executor = fs.readFileSync(EXECUTOR_PATH, 'utf8');

function needsCoverage(prop: string): boolean {
  return !TRIVIAL_PROPS.has(prop) && !INTENTIONALLY_UNIMPLEMENTED.has(prop);
}

describe('CLI / UI parity — schema features must be documented + implemented', () => {
  describe('SKILL.md (CLI) must mention every schema property', () => {
    for (const prop of allProps) {
      if (!needsCoverage(prop)) continue;
      it(`mentions \`${prop}\``, () => {
        expect(skill).toContain(prop.toLowerCase());
      });
    }
  });

  describe('SKILL.md (CLI) must explain every body kind', () => {
    for (const kind of bodyKinds) {
      it(`covers \`${kind}\``, () => {
        expect(skill).toContain(kind.toLowerCase());
      });
    }
  });

  describe('executor.ts (web) must reference every schema property', () => {
    for (const prop of allProps) {
      if (!needsCoverage(prop)) continue;
      it(`handles \`${prop}\``, () => {
        const pattern = new RegExp(`\\b${prop}\\b`);
        expect(pattern.test(executor)).toBe(true);
      });
    }
  });

  describe('executor.ts (web) must reference every body kind', () => {
    for (const kind of bodyKinds) {
      it(`handles \`${kind}\``, () => {
        const pattern = new RegExp(`\\b${kind}\\b`);
        expect(pattern.test(executor)).toBe(true);
      });
    }
  });
});
