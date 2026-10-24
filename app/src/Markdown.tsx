import { Fragment, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** Tiny markdown renderer for agent output in the Runs viewer.
 *
 *  We deliberately don't pull in `react-markdown` / `marked` —
 *  agent output is usually short and we only need a handful of
 *  block types. Roll-our-own gives us total control over styling +
 *  zero new dependencies + zero CSS-in-JS-vs-RN impedance issues.
 *
 *  Supported:
 *  - ATX headings (# ## ### #### ##### ######)
 *  - Bullet lists (`- ` / `* `)
 *  - Ordered lists (`1. ` `2. `)
 *  - Fenced code blocks (```)
 *  - Blockquotes (`> `)
 *  - GFM pipe tables (`| a | b |` + `| --- | --- |` separator + rows)
 *  - Horizontal rules (`---` / `***` / `___`, 3+)
 *  - Inline: **bold**, *italic*, `code`, [link](url)
 *  - Paragraphs (blank line separated)
 *
 *  Not supported (silently fall through as text):
 *  - Footnotes, html, image embeds.
 *
 *  Edge cases handled:
 *  - Mixed indentation in lists (no nesting; flat-only for v1).
 *  - Code blocks with language tags (```ts).
 *  - URLs without [text](...) wrapper render as text (no autolink). */
export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => (
        <BlockRender key={i} block={b} />
      ))}
    </View>
  );
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lang?: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; align: ColAlign[]; rows: string[][] };

type ColAlign = 'left' | 'center' | 'right';

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // Skip closing fence (if present).
      if (i < lines.length) i++;
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, text: heading[2] });
      i++;
      continue;
    }

    // Horizontal rule — a line of 3+ `-`, `*`, or `_` (spaces allowed
    // between markers, e.g. `* * *`). Checked before lists so a bare
    // `---` / `***` becomes a divider, not a one-item bullet list.
    if (isHrLine(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // GFM pipe table — a header row, a `| --- | :--: |` separator row,
    // then 1+ body rows. Detected before lists/paragraphs so the pipe
    // rows aren't swallowed as plain text.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = parseTableAlign(lines[i + 1], header.length);
      i += 2; // consume header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        if (isHrLine(lines[i])) break; // a rule ends the table
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    // Blockquote — gather contiguous `> ` lines.
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    // Unordered list — gather contiguous `- ` / `* ` items.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list — gather contiguous `1. ` `2. ` items.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Blank line — block separator, eat it.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph — gather contiguous non-empty, non-special lines.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        /^```/.test(l) ||
        /^#{1,6}\s/.test(l) ||
        /^[-*]\s+/.test(l) ||
        /^\d+\.\s+/.test(l) ||
        /^>\s?/.test(l) ||
        isHrLine(l) ||
        (l.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    if (para.length > 0) {
      blocks.push({ kind: 'para', text: para.join(' ') });
    }
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Table + horizontal-rule helpers                                            */
/* -------------------------------------------------------------------------- */

/** True for a thematic-break line: 3+ of `-`, `*`, or `_` (a single
 *  marker repeated), spaces between markers allowed (`* * *`). */
function isHrLine(line: string): boolean {
  const t = line.trim();
  return /^(?:-\s*){3,}$/.test(t) || /^(?:\*\s*){3,}$/.test(t) || /^(?:_\s*){3,}$/.test(t);
}

/** The separator row under a GFM table header: each cell is dashes with
 *  optional leading/trailing colons for alignment (`---`, `:--`, `:-:`,
 *  `--:`). Must contain at least one `|` and at least one dash cell. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  const cells = splitTableRow(t);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/** Split a `| a | b |` row into trimmed cells, dropping the empty
 *  edges produced by leading/trailing pipes. A `\|` escapes a literal
 *  pipe inside a cell. */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    const ch = t[k];
    if (ch === '\\' && t[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Map a separator row to per-column alignment, padded/truncated to the
 *  header column count. `:--` left, `:-:` center, `--:` right. */
function parseTableAlign(line: string, cols: number): ColAlign[] {
  const cells = splitTableRow(line);
  const out: ColAlign[] = [];
  for (let k = 0; k < cols; k++) {
    const c = (cells[k] ?? '').trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    out.push(left && right ? 'center' : right ? 'right' : 'left');
  }
  return out;
}

function BlockRender({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text style={[styles.heading, headingSizes[block.level]]}>
          <Inline text={block.text} />
        </Text>
      );
    case 'para':
      return (
        <Text style={styles.para}>
          <Inline text={block.text} />
        </Text>
      );
    case 'ul':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.listText}>
                <Inline text={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'ol':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={styles.bullet}>{i + 1}.</Text>
              <Text style={styles.listText}>
                <Inline text={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'code':
      return (
        <View style={styles.codeBlock}>
          {block.lang && <Text style={styles.codeLang}>{block.lang}</Text>}
          <Text style={styles.codeText} selectable>
            {block.text}
          </Text>
        </View>
      );
    case 'quote':
      return (
        <View style={styles.quoteBlock}>
          <Text style={styles.quoteText}>
            <Inline text={block.text} />
          </Text>
        </View>
      );
    case 'hr':
      return <View style={styles.hr} />;
    case 'table':
      return <TableRender header={block.header} align={block.align} rows={block.rows} />;
  }
}

/** Render a GFM table as a bordered grid of Views. Each row is a flex
 *  row; each cell is a flex:1 View holding inline-rendered Text. The
 *  outer container draws the top + left borders; every cell draws its
 *  right + bottom border, so internal grid lines never double up. The
 *  header row is shaded + bold. Columns size equally (flex:1) — robust
 *  for the short tables agents emit, no measure pass needed. */
function TableRender({
  header,
  align,
  rows,
}: {
  header: string[];
  align: ColAlign[];
  rows: string[][];
}) {
  const cols = header.length;
  const cellAlign = (i: number): ColAlign => align[i] ?? 'left';
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        {header.map((cell, c) => (
          <View key={c} style={styles.tableCell}>
            <Text style={[styles.tableCellText, styles.tableHeaderText, textAlign(cellAlign(c))]}>
              <Inline text={cell} />
            </Text>
          </View>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={styles.tableRow}>
          {Array.from({ length: cols }).map((_, c) => (
            <View key={c} style={styles.tableCell}>
              <Text style={[styles.tableCellText, textAlign(cellAlign(c))]}>
                <Inline text={row[c] ?? ''} />
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const textAlignStyles = StyleSheet.create({
  left: { textAlign: 'left' },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
});
function textAlign(a: ColAlign) {
  return textAlignStyles[a];
}

/** Render inline-level markdown: **bold**, *italic*, `code`, [link](url).
 *  Tokenizes by scanning left-to-right and emitting <Text> spans with
 *  matching styles. Unknown / malformed markup falls through as plain
 *  text (don't fight the input — agent output is messy). */
function Inline({ text }: { text: string }) {
  const spans = tokenizeInline(text);
  return (
    <Fragment>
      {spans.map((s, i) => (
        <Text key={i} style={s.style}>
          {s.text}
        </Text>
      ))}
    </Fragment>
  );
}

type Span = { text: string; style?: object };

function tokenizeInline(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  while (i < text.length) {
    // Inline code: `...`
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        out.push({ text: text.slice(i + 1, end), style: styles.inlineCode });
        i = end + 1;
        continue;
      }
    }
    // Bold: **...**
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 1) {
        out.push({ text: text.slice(i + 2, end), style: styles.bold });
        i = end + 2;
        continue;
      }
    }
    // Italic: *...* or _..._  (not when adjacent to letters to avoid
    // tearing apart names like `agent_path` and `multi*action`).
    if (
      (text[i] === '*' || text[i] === '_') &&
      text[i] !== text[i + 1] &&
      !/\w/.test(text[i - 1] ?? '')
    ) {
      const marker = text[i];
      const end = text.indexOf(marker, i + 1);
      if (end > i + 1 && !/\w/.test(text[end + 1] ?? '')) {
        out.push({ text: text.slice(i + 1, end), style: styles.italic });
        i = end + 1;
        continue;
      }
    }
    // Link: [text](url) — render the text portion only.
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket > i && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          out.push({
            text: text.slice(i + 1, closeBracket),
            style: styles.link,
          });
          i = closeParen + 1;
          continue;
        }
      }
    }
    // Plain text — accumulate until we hit a known marker.
    let j = i + 1;
    while (
      j < text.length &&
      text[j] !== '`' &&
      !(text[j] === '*' && text[j + 1] === '*') &&
      text[j] !== '*' &&
      text[j] !== '_' &&
      text[j] !== '['
    ) {
      j++;
    }
    const lastSpan = out[out.length - 1];
    if (lastSpan && !lastSpan.style) {
      lastSpan.text += text.slice(i, j);
    } else {
      out.push({ text: text.slice(i, j) });
    }
    i = j;
  }
  return mergeAdjacent(out);
}

function mergeAdjacent(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && !last.style && !s.style) {
      last.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

const headingSizes: Record<1 | 2 | 3 | 4 | 5 | 6, { fontSize: number; marginTop: number }> = {
  1: { fontSize: 18, marginTop: 8 },
  2: { fontSize: 16, marginTop: 8 },
  3: { fontSize: 14, marginTop: 6 },
  4: { fontSize: 13, marginTop: 6 },
  5: { fontSize: 12, marginTop: 6 },
  6: { fontSize: 12, marginTop: 6 },
};

const styles = StyleSheet.create({
  root: { gap: 6 },
  heading: { fontWeight: '700', color: '#111827' },
  para: { fontSize: 12, color: '#111827', lineHeight: 18 },
  list: { gap: 2, paddingLeft: 4 },
  listRow: { flexDirection: 'row', gap: 6 },
  bullet: { fontSize: 12, color: '#6b7280', minWidth: 14, fontFamily: 'Menlo' },
  listText: { flex: 1, fontSize: 12, color: '#111827', lineHeight: 18 },
  codeBlock: {
    backgroundColor: '#0f172a',
    borderRadius: 4,
    padding: 8,
    marginVertical: 2,
  },
  codeLang: {
    fontSize: 9,
    color: '#94a3b8',
    fontFamily: 'Menlo',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  codeText: { color: '#e2e8f0', fontFamily: 'Menlo', fontSize: 11, lineHeight: 16 },
  quoteBlock: {
    borderLeftWidth: 3,
    borderLeftColor: '#cbd5e1',
    paddingLeft: 8,
    paddingVertical: 2,
  },
  quoteText: { fontSize: 12, color: '#475569', fontStyle: 'italic' },
  hr: {
    height: 1,
    backgroundColor: '#d1d5db',
    marginVertical: 6,
    alignSelf: 'stretch',
  },
  table: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
    borderRadius: 4,
    overflow: 'hidden',
    marginVertical: 2,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  tableRow: { flexDirection: 'row', alignItems: 'stretch' },
  tableHeaderRow: { backgroundColor: '#f3f4f6' },
  tableCell: {
    flex: 1,
    minWidth: 60,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#d1d5db',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  tableCellText: { fontSize: 12, color: '#111827', lineHeight: 17 },
  tableHeaderText: { fontWeight: '700', color: '#111827' },
  inlineCode: {
    fontFamily: 'Menlo',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 3,
    fontSize: 11,
    color: '#be123c',
  },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { color: '#2563eb', textDecorationLine: 'underline' },
});

// Suppress unused-import warning when no inline links are present.
export type _MarkdownAvoidUnused = ReactNode;
