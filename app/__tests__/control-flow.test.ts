import {
  decideLoopJudge,
  decideRoute,
  decideSwitch,
  extractJson,
} from '../src/llm/control-flow';

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"branch":"bug"}')).toEqual({ branch: 'bug' });
  });
  it('parses a fenced ```json block', () => {
    expect(extractJson('Sure!\n```json\n{"decision":"STOP"}\n```')).toEqual({
      decision: 'STOP',
    });
  });
  it('parses JSON embedded in prose', () => {
    expect(extractJson('I think {"score": 0.9} is right')).toEqual({ score: 0.9 });
  });
  it('parses a bare number to a number (not an object)', () => {
    expect(extractJson('0.95')).toBe(0.95);
  });
  it('returns null for non-JSON prose', () => {
    expect(extractJson('STOP')).toBeNull();
    expect(extractJson('continue please')).toBeNull();
  });
});

describe('decideRoute', () => {
  const keys = ['bug', 'feature'];

  it('takes the structured branch (case-insensitive)', () => {
    expect(decideRoute('{"branch":"feature"}', keys, false)).toEqual({
      branch: 'feature',
      via: 'json',
    });
    expect(decideRoute('{"branch":"BUG"}', keys, false)).toEqual({
      branch: 'bug',
      via: 'json',
    });
  });

  it('does not mis-route on a branch name mentioned in prose when JSON is present', () => {
    // Structured verdict is "feature"; the word "bug" also appears in prose.
    const r = decideRoute(
      'This is clearly a bug-adjacent feature. {"branch":"feature"}',
      keys,
      false,
    );
    expect(r).toEqual({ branch: 'feature', via: 'json' });
  });

  it('resolves an explicit structured "default" to null (caller uses default)', () => {
    expect(decideRoute('{"branch":"default"}', keys, true)).toBeNull();
  });

  it('falls back to substring for a bare branch name (back-compat)', () => {
    expect(decideRoute('bug', keys, false)).toEqual({ branch: 'bug', via: 'substring' });
  });

  it('falls back to substring when the structured branch is unknown', () => {
    // Unknown structured branch, but "feature" appears in the text → substring.
    expect(decideRoute('{"branch":"nope"} feature', keys, false)).toEqual({
      branch: 'feature',
      via: 'substring',
    });
  });

  it('returns null when nothing matches', () => {
    expect(decideRoute('no idea', keys, false)).toBeNull();
  });
});

describe('decideLoopJudge', () => {
  it('structured STOP / CONTINUE (default mode)', () => {
    expect(decideLoopJudge('{"decision":"STOP"}', {})).toMatchObject({
      stop: true,
      reason: 'judge said STOP',
      via: 'json',
    });
    expect(decideLoopJudge('{"decision":"CONTINUE"}', {})).toEqual({ stop: false });
  });

  it('structured stop:true always wins, even below threshold', () => {
    expect(
      decideLoopJudge('{"score":0.1,"stop":true}', { stopAtScore: 0.9 }),
    ).toMatchObject({ stop: true, via: 'json' });
  });

  it('structured score crosses / misses the threshold', () => {
    expect(
      decideLoopJudge('{"score":0.95,"stop":false}', { stopAtScore: 0.8 }),
    ).toMatchObject({ stop: true, reason: 'judge score 0.95 ≥ stopAtScore 0.8' });
    expect(
      decideLoopJudge('{"score":0.5,"stop":false}', { stopAtScore: 0.8 }),
    ).toEqual({ stop: false });
  });

  it('does NOT stop on "do not stop" prose when structured says CONTINUE', () => {
    // The brittle old path: includes("stop") fires on "do not stop".
    expect(
      decideLoopJudge('We should not stop yet. {"decision":"CONTINUE"}', {}),
    ).toEqual({ stop: false });
  });

  // --- back-compat fallback (matches the legacy substring/parseFloat path) ---

  it('falls back to a bare STOP', () => {
    expect(decideLoopJudge('STOP', { stopAtScore: 0.9 })).toMatchObject({
      stop: true,
      reason: 'judge said STOP',
      via: 'substring',
    });
  });

  it('falls back to a bare numeric score', () => {
    expect(decideLoopJudge('0.95', { stopAtScore: 0.8 })).toMatchObject({
      stop: true,
      reason: 'judge score 0.95 ≥ stopAtScore 0.8',
      via: 'substring',
    });
    expect(decideLoopJudge('0.4', { stopAtScore: 0.8 })).toEqual({ stop: false });
  });

  it('continues by default when nothing indicates a stop', () => {
    expect(decideLoopJudge('keep going', {})).toEqual({ stop: false });
  });
});

describe('decideSwitch', () => {
  const tf = ['true', 'false'];
  const xyz = ['x', 'y', 'z'];

  it('matches a bare value exactly', () => {
    expect(decideSwitch('true', tf)).toBe('true');
    expect(decideSwitch('false', tf)).toBe('false');
    expect(decideSwitch('y', xyz)).toBe('y');
  });

  it('is case-insensitive and trims + strips wrapping quotes', () => {
    expect(decideSwitch('  TRUE\n', tf)).toBe('true');
    expect(decideSwitch('"false"', tf)).toBe('false');
    expect(decideSwitch("'Z'", xyz)).toBe('z');
  });

  it('returns the ORIGINAL case key (preserves caller casing)', () => {
    expect(decideSwitch('approve', ['Approve', 'Reject'])).toBe('Approve');
  });

  it('does NOT substring-match (false must not hit a true case)', () => {
    // "false" contains no "true"; but critically a value that merely mentions
    // a key in prose should not match — only exact/structured/last-line do.
    expect(decideSwitch('this is definitely a true-ish vibe', tf)).toBeNull();
  });

  it('reads a structured {"case": ...} verdict', () => {
    expect(decideSwitch('Reasoning… {"case":"z"}', xyz)).toBe('z');
    expect(decideSwitch('{"value":"FALSE"}', tf)).toBe('false');
    expect(decideSwitch('{"result":true}', tf)).toBe('true');
  });

  it('falls back to the last non-empty line (scripts print the verdict last)', () => {
    expect(decideSwitch('working…\ndone thinking\nx', xyz)).toBe('x');
  });

  it('returns null when nothing matches', () => {
    expect(decideSwitch('maybe', tf)).toBeNull();
    expect(decideSwitch('', xyz)).toBeNull();
  });
});
