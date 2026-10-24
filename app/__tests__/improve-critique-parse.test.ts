/**
 * Unit tests for the "Improve orchestration" critique → checklist plumbing:
 *
 *   (a) parseCritiqueItems  — turn the orchestration-improver's critique
 *       markdown into discrete, section-grouped, individually-checkable items.
 *   (b) buildSelectedInstruction — turn the CHECKED subset back into the
 *       focused instruction set the designer (revise) pass receives, so
 *       "Apply" reflects only the user-approved suggestions.
 *
 * These are the pure cores the ImproveOrchestrationModal's checkbox-apply flow
 * is built on; keeping them pure makes the parse + apply-only-selected logic
 * testable without rendering React Native.
 */

import {
  parseCritiqueItems,
  buildSelectedInstruction,
  type ImproveItem,
} from '../src/store/improveJobs';

// A critique in the exact shape agents/orchestration-improver.md emits:
// `## section` headings + `- **bold title** — why` bullets.
const SAMPLE = `Here is my review.

## Risks / missing safety
- **Add \`lock: true\` on \`publish\`** — it has an irreversible side effect and should gate on human approval.
- **Wrap \`qa\` with \`retry: { times: 2 }\`** — the iOS simulator drops connections under load.

## Cost / budget
- **Add \`budget: { maxCostUsd: 5 }\` on the \`explore\` loop** — it can iterate unbounded by default.

## Parallelization opportunities
- **\`lint\` and \`typecheck\` are independent** — wrap them in \`parallel\` to cut wall-clock.

## What's already good
- Sensible agent fit across the board.
`;

describe('parseCritiqueItems', () => {
  test('parses each bullet into an item, preserving section grouping', () => {
    const items = parseCritiqueItems(SAMPLE);
    expect(items).toHaveLength(5);

    // Sections preserved + grouped in document order.
    expect(items.map(i => i.section)).toEqual([
      'Risks / missing safety',
      'Risks / missing safety',
      'Cost / budget',
      'Parallelization opportunities',
      "What's already good",
    ]);

    // Default selected = true for every item.
    expect(items.every(i => i.selected)).toBe(true);

    // IDs are unique + stable.
    expect(new Set(items.map(i => i.id)).size).toBe(items.length);
  });

  test('splits a bold bullet into title (lead phrase) + detail (the why)', () => {
    const [first] = parseCritiqueItems(SAMPLE);
    expect(first.title).toBe('Add `lock: true` on `publish`');
    expect(first.detail).toBe(
      'it has an irreversible side effect and should gate on human approval.',
    );
  });

  test('handles an unbolded bullet by splitting on the first separator', () => {
    const items = parseCritiqueItems(
      '## Clarity\n- Rename foo to bar — clearer intent\n',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      section: 'Clarity',
      title: 'Rename foo to bar',
      detail: 'clearer intent',
    });
  });

  test('bullets with no detail keep an empty detail string', () => {
    const items = parseCritiqueItems('## X\n- **Just a title**\n');
    expect(items[0].title).toBe('Just a title');
    expect(items[0].detail).toBe('');
  });

  test('groups pre-heading bullets under a generic section (nothing dropped)', () => {
    const items = parseCritiqueItems('- **Loose suggestion** — before any heading\n');
    expect(items).toHaveLength(1);
    expect(items[0].section).toBe('Improvements');
    expect(items[0].title).toBe('Loose suggestion');
  });

  test('returns [] for empty / heading-only / prose-only critiques (caller falls back to raw)', () => {
    expect(parseCritiqueItems('')).toEqual([]);
    expect(parseCritiqueItems('## Just a heading\n\nSome prose, no bullets.')).toEqual(
      [],
    );
  });

  test('tolerates CRLF line endings', () => {
    const items = parseCritiqueItems(
      '## Risks\r\n- **Add retry** — flaky\r\n',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ section: 'Risks', title: 'Add retry' });
  });
});

describe('buildSelectedInstruction', () => {
  test('includes ONLY the checked items, regrouped by section', () => {
    const items = parseCritiqueItems(SAMPLE);
    // Uncheck everything except the two safety items + the cost item.
    const selected: ImproveItem[] = items.map(i => ({
      ...i,
      selected:
        i.section === 'Risks / missing safety' || i.section === 'Cost / budget',
    }));

    const instruction = buildSelectedInstruction(selected);

    // Checked items are present...
    expect(instruction).toContain('## Risks / missing safety');
    expect(instruction).toContain('Add `lock: true` on `publish`');
    expect(instruction).toContain('Wrap `qa` with `retry: { times: 2 }`');
    expect(instruction).toContain('## Cost / budget');
    expect(instruction).toContain('Add `budget: { maxCostUsd: 5 }` on the `explore` loop');

    // ...and UNchecked items are excluded — this is the core guarantee.
    expect(instruction).not.toContain('Parallelization');
    expect(instruction).not.toContain('lint');
    expect(instruction).not.toContain("already good");
  });

  test('round-trips title + detail into a bold bullet the designer can read', () => {
    const items: ImproveItem[] = [
      { id: '0-0', section: 'Cost', title: 'Drop effort to medium', detail: 'cheaper', selected: true },
    ];
    expect(buildSelectedInstruction(items)).toBe(
      '## Cost\n- **Drop effort to medium** — cheaper',
    );
  });

  test('omits the separator when an item has no detail', () => {
    const items: ImproveItem[] = [
      { id: '0-0', section: 'X', title: 'Title only', detail: '', selected: true },
    ];
    expect(buildSelectedInstruction(items)).toBe('## X\n- **Title only**');
  });

  test('returns "" when nothing is selected (so callers can disable Apply)', () => {
    const items = parseCritiqueItems(SAMPLE).map(i => ({ ...i, selected: false }));
    expect(buildSelectedInstruction(items)).toBe('');
    expect(buildSelectedInstruction([])).toBe('');
  });

  test('a single selected item yields just that one bullet', () => {
    const items = parseCritiqueItems(SAMPLE).map((i, idx) => ({
      ...i,
      selected: idx === 2, // the cost item
    }));
    const instruction = buildSelectedInstruction(items);
    expect(instruction).toBe(
      '## Cost / budget\n- **Add `budget: { maxCostUsd: 5 }` on the `explore` loop** — it can iterate unbounded by default.',
    );
  });
});
