/**
 * Convert an uploaded file (image / .drawio / .excalidraw / PDF /
 * text) into a normalized representation the orchestration designer
 * agent can consume:
 *
 *   - images become {type:'image', mediaType, base64}
 *   - structured-graph files (drawio, excalidraw) become
 *     {type:'text', text: "DIAGRAM (parsed):\n<labeled graph>"}
 *   - PDFs return text-content per page (no rasterization — keeps the
 *     dep footprint to pdfjs-dist without pulling in `canvas`)
 *   - plain text / markdown AND text-bearing data formats (JSON, YAML,
 *     CSV) pass through as a single text block — the consuming phase
 *     parses them itself
 *
 * The endpoint that wraps this then assembles the content blocks into
 * the SDK's user-message array, alongside the designer's system
 * prompt. Vision-capable models read everything together.
 */

import pako from 'pako';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string };

export type ExtractResult = {
  /** Content blocks ready to attach as the user message. */
  blocks: ContentBlock[];
  /** Short label describing what we found — surfaced in the UI so the
   *  user knows the file was understood (e.g. "PDF · 3 pages, 1.2 KB
   *  of text extracted", "drawio · 8 nodes + 9 edges"). */
  summary: string;
};

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/** Pick a representation by extension/mime and dispatch to the right
 *  extractor. Throws a friendly error for anything unsupported so the
 *  endpoint can return 415. */
export async function extractFromUpload(
  filename: string,
  mime: string,
  bytes: Buffer,
): Promise<ExtractResult> {
  const lower = filename.toLowerCase();
  if (IMAGE_MIME.has(mime) || /\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    const m = mime && IMAGE_MIME.has(mime) ? mime : guessImageMime(lower);
    return {
      blocks: [{ type: 'image', mediaType: m, base64: bytes.toString('base64') }],
      summary: `image · ${m} · ${formatBytes(bytes.length)}`,
    };
  }
  if (lower.endsWith('.drawio') || lower.endsWith('.xml')) {
    return extractDrawio(bytes);
  }
  if (lower.endsWith('.excalidraw') || lower.endsWith('.excalidraw.json')) {
    return extractExcalidraw(bytes);
  }
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    return extractPdf(bytes);
  }
  // Text + text-bearing data formats pass through as a single text block.
  // JSON/YAML/CSV are the common case the resolver hit (an auditspec, a
  // config, a data manifest); they're plain UTF-8 text the downstream phase
  // parses itself, so rejecting them as "unsupported" forced callers to lie
  // about the media type (send JSON as text/plain). `application/*+json` /
  // `+yaml` (e.g. application/ld+json) are tolerated via the suffix test.
  if (
    /^text\//.test(mime) ||
    /^application\/(json|xml|x-ndjson|(x-)?yaml|csv|.*\+(json|xml|yaml))$/i.test(
      mime,
    ) ||
    /\.(md|txt|mmd|json|jsonl|ndjson|ya?ml|csv|tsv)$/i.test(lower) ||
    !mime
  ) {
    const text = bytes.toString('utf8');
    return {
      blocks: [{ type: 'text', text }],
      summary: `text · ${formatBytes(bytes.length)}`,
    };
  }
  throw new Error(
    `Unsupported file type: ${mime || lower}. Supported: images (png/jpg/gif/webp), .drawio, .xml, .excalidraw, .pdf, and text/data files (.md, .txt, .mmd, .json, .jsonl, .yaml, .csv, .tsv)`,
  );
}

// ─── Folder aggregation ────────────────────────────────────────────
//
// A spec is sometimes a whole FOLDER of files (a PRD split across
// markdown sections, a diagram beside its notes, a directory of
// requirements). `extractFromFolder` runs `extractFromUpload` over each
// file and concatenates the results into ONE block array, prepending a
// `## File: <relPath>` text header before each file's blocks so the
// designer agent sees the folder STRUCTURE (paths are signal). To keep
// the prompt bounded, it caps the input by file COUNT and by total
// extracted TEXT size — when a cap is hit, the remaining files are
// DROPPED (never silently truncated) and listed in the returned summary
// so the user knows exactly what was left out.

export type FolderFile = {
  /** Path relative to the picked folder root (from webkitRelativePath). */
  relPath: string;
  filename: string;
  mediaType: string;
  /** Raw decoded bytes for this file. */
  bytes: Buffer;
};

/** Default caps — tuned to keep a folder's combined prompt sane.
 *  Exported so the endpoint can surface the limits in its drop notice. */
export const FOLDER_MAX_FILES = 40;
/** ~250 KB of EXTRACTED TEXT (image blocks don't count toward this —
 *  they're capped by file count only). */
export const FOLDER_MAX_TEXT_BYTES = 250 * 1024;

export async function extractFromFolder(
  files: FolderFile[],
): Promise<ExtractResult & { droppedNote: string | null }> {
  const blocks: ContentBlock[] = [];
  const perFileSummaries: string[] = [];
  const dropped: string[] = [];
  let textBytes = 0;
  let usedFiles = 0;

  // Stable ordering by relative path so the agent sees a predictable
  // tree and re-runs are deterministic.
  const ordered = [...files].sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );

  for (const f of ordered) {
    // File-count cap — drop the rest, record them, stop extracting.
    if (usedFiles >= FOLDER_MAX_FILES) {
      dropped.push(f.relPath);
      continue;
    }
    let result: ExtractResult;
    try {
      result = await extractFromUpload(f.filename, f.mediaType, f.bytes);
    } catch (err) {
      // Unsupported / unparseable file in the folder — skip it but note
      // it rather than failing the whole folder.
      dropped.push(`${f.relPath} (${(err as Error).message})`);
      continue;
    }
    // Measure this file's text contribution; enforce the text-size cap.
    const fileTextBytes = result.blocks.reduce(
      (n, b) => n + (b.type === 'text' ? Buffer.byteLength(b.text, 'utf8') : 0),
      0,
    );
    if (textBytes + fileTextBytes > FOLDER_MAX_TEXT_BYTES && usedFiles > 0) {
      // Adding this file would blow the text budget — drop it (and,
      // implicitly, the remaining ones, since they're only larger in
      // aggregate). We still keep iterating to record every dropped
      // path in the summary.
      dropped.push(f.relPath);
      continue;
    }
    // Prepend the structural header, then this file's blocks.
    blocks.push({ type: 'text', text: `\n\n## File: ${f.relPath}\n` });
    blocks.push(...result.blocks);
    textBytes += fileTextBytes;
    usedFiles += 1;
    perFileSummaries.push(`${f.relPath} → ${result.summary}`);
  }

  const droppedNote = dropped.length
    ? `NOTE: ${dropped.length} file(s) were NOT included because the ` +
      `folder exceeded the cap (max ${FOLDER_MAX_FILES} files / ` +
      `${formatBytes(FOLDER_MAX_TEXT_BYTES)} of extracted text). ` +
      `Dropped: ${dropped.join(', ')}.`
    : null;

  // If something was dropped, surface it INSIDE the prompt too so the
  // agent knows the spec is partial (no silent truncation).
  if (droppedNote) {
    blocks.push({ type: 'text', text: `\n\n${droppedNote}\n` });
  }

  const summary =
    `folder · ${usedFiles}/${files.length} file(s) · ` +
    `${formatBytes(textBytes)} text` +
    (dropped.length ? ` · ${dropped.length} dropped (cap)` : '');

  return { blocks, summary, droppedNote };
}

function guessImageMime(filename: string): string {
  const ext = filename.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ─── .drawio extractor ─────────────────────────────────────────────
//
// drawio files are XML. The interesting `<mxGraphModel>` block is
// usually wrapped in `<mxfile><diagram>…</diagram></mxfile>`. The
// inner content is EITHER the model XML directly OR a
// base64+raw-deflate compressed payload (drawio's "compressed XML"
// option). We try both. After we have the model, we walk
// <mxCell> entries and extract:
//   - id → label  (for shape cells)
//   - source → target  (for edge cells)
// and feed a numbered listing back to the LLM. Far more reliable than
// asking the LLM to read pixels.

export async function extractDrawio(bytes: Buffer): Promise<ExtractResult> {
  const raw = bytes.toString('utf8');
  const inner = unwrapDrawio(raw);
  if (!inner) {
    return {
      blocks: [{ type: 'text', text: raw }],
      summary: `drawio · raw XML (no <diagram> wrapper found, passed verbatim)`,
    };
  }
  const { nodes, edges } = parseMxGraphModel(inner);
  const lines: string[] = [];
  lines.push('DIAGRAM (parsed from .drawio):');
  lines.push('');
  lines.push(`Nodes (${nodes.length}):`);
  for (const n of nodes) {
    lines.push(`  - ${n.id}: "${n.label}"`);
  }
  lines.push('');
  lines.push(`Edges (${edges.length}):`);
  for (const e of edges) {
    const src = nodes.find(n => n.id === e.source)?.label ?? e.source;
    const tgt = nodes.find(n => n.id === e.target)?.label ?? e.target;
    const lab = e.label ? ` [label: ${e.label}]` : '';
    lines.push(`  - ${src} → ${tgt}${lab}`);
  }
  return {
    blocks: [{ type: 'text', text: lines.join('\n') }],
    summary: `drawio · ${nodes.length} nodes + ${edges.length} edges`,
  };
}

/** Pull the <mxGraphModel>...</mxGraphModel> out of a drawio file's
 *  outer wrapper. Returns null if we can't find one. */
function unwrapDrawio(raw: string): string | null {
  // Already an mxGraphModel?
  if (/<mxGraphModel\b/.test(raw)) return raw;
  // Look for <diagram>...inner...</diagram>. Inner is either plain
  // XML or base64+deflate.
  const diagram = raw.match(/<diagram[^>]*>([\s\S]*?)<\/diagram>/);
  if (!diagram) return null;
  const inner = diagram[1].trim();
  if (/^</.test(inner)) return inner;
  // Compressed: base64 → raw deflate → URI-decoded XML.
  try {
    const buf = Buffer.from(inner, 'base64');
    // drawio uses raw deflate without zlib header (windowBits = -15).
    const inflated = pako.inflateRaw(buf, { to: 'string' });
    // The inflated content is URI-encoded XML.
    return decodeURIComponent(inflated);
  } catch {
    return null;
  }
}

function parseMxGraphModel(xml: string): {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ source: string; target: string; label: string }>;
} {
  const nodes: Array<{ id: string; label: string }> = [];
  const edges: Array<{ source: string; target: string; label: string }> = [];
  // Match every <mxCell ... /> or <mxCell ...>...</mxCell>. Attributes
  // we care about: id, value (label), edge, source, target.
  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const id = attrs.id;
    if (!id || id === '0' || id === '1') continue;
    const value = decodeXmlText(attrs.value ?? '');
    if (attrs.edge === '1') {
      if (attrs.source && attrs.target) {
        edges.push({ source: attrs.source, target: attrs.target, label: value });
      }
      continue;
    }
    if (attrs.vertex === '1' || value) {
      nodes.push({ id, label: value || `(unlabeled ${id})` });
    }
  }
  return { nodes, edges };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
    // Strip HTML tags drawio puts inside cell values for rich text.
    .replace(/<[^>]+>/g, '')
    .trim();
}

// ─── .excalidraw extractor ─────────────────────────────────────────
//
// Excalidraw scenes are JSON with an `elements` array. Shapes
// (rectangle, ellipse, diamond) carry a label via either the element's
// own `text` field OR a nearby text element bound via `boundElements`.
// Arrows have `startBinding` + `endBinding` pointing at the shapes.

export async function extractExcalidraw(bytes: Buffer): Promise<ExtractResult> {
  let scene: unknown;
  try {
    scene = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(
      `Couldn't parse .excalidraw file as JSON: ${(err as Error).message}`,
    );
  }
  if (
    !scene ||
    typeof scene !== 'object' ||
    !Array.isArray((scene as { elements?: unknown }).elements)
  ) {
    throw new Error('.excalidraw file missing `elements` array');
  }
  const elements = (scene as { elements: Array<Record<string, unknown>> }).elements;

  // Pass 1: collect text elements + map by container id.
  const textsById = new Map<string, string>();
  const textsByContainer = new Map<string, string>();
  for (const e of elements) {
    if (e.type === 'text' && typeof e.id === 'string' && typeof e.text === 'string') {
      textsById.set(e.id, e.text);
      if (typeof e.containerId === 'string') {
        textsByContainer.set(e.containerId, e.text);
      }
    }
  }

  // Pass 2: shapes (anything with type rectangle/ellipse/diamond) →
  // labeled nodes; arrows → edges.
  const nodes: Array<{ id: string; label: string }> = [];
  const edges: Array<{ source: string; target: string; label: string }> = [];
  for (const e of elements) {
    const id = e.id as string | undefined;
    if (!id) continue;
    const type = e.type as string;
    if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') {
      const direct = typeof e.text === 'string' ? (e.text as string) : '';
      const label = direct || textsByContainer.get(id) || '(unlabeled)';
      nodes.push({ id, label });
    } else if (type === 'arrow' || type === 'line') {
      const startBinding = e.startBinding as { elementId?: string } | undefined;
      const endBinding = e.endBinding as { elementId?: string } | undefined;
      if (startBinding?.elementId && endBinding?.elementId) {
        const labelId = Array.isArray(e.boundElements)
          ? (e.boundElements as Array<{ id?: string; type?: string }>).find(
              b => b.type === 'text',
            )?.id
          : undefined;
        const label = labelId ? (textsById.get(labelId) ?? '') : '';
        edges.push({
          source: startBinding.elementId,
          target: endBinding.elementId,
          label,
        });
      }
    }
  }

  const lines: string[] = [];
  lines.push('DIAGRAM (parsed from .excalidraw):');
  lines.push('');
  lines.push(`Nodes (${nodes.length}):`);
  for (const n of nodes) lines.push(`  - ${n.id}: "${n.label}"`);
  lines.push('');
  lines.push(`Edges (${edges.length}):`);
  for (const e of edges) {
    const src = nodes.find(n => n.id === e.source)?.label ?? e.source;
    const tgt = nodes.find(n => n.id === e.target)?.label ?? e.target;
    const lab = e.label ? ` [label: ${e.label}]` : '';
    lines.push(`  - ${src} → ${tgt}${lab}`);
  }
  return {
    blocks: [{ type: 'text', text: lines.join('\n') }],
    summary: `excalidraw · ${nodes.length} nodes + ${edges.length} edges`,
  };
}

// ─── PDF extractor ─────────────────────────────────────────────────
//
// We extract TEXT per page rather than rasterizing — the latter would
// require `canvas` (cairo native bindings) which is a heavy peer dep.
// For PRDs the text usually describes the flow well enough; if the
// user wants the diagram itself parsed visually, they should drop the
// diagram as an image alongside the PDF.

export async function extractPdf(bytes: Buffer): Promise<ExtractResult> {
  // pdfjs-dist Node usage requires the legacy build. We import
  // dynamically so this entire dep tree (~5 MB) doesn't load unless a
  // PDF is actually uploaded.
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (opts: { data: Uint8Array }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{
            items: Array<{ str?: string }>;
          }>;
        }>;
      }>;
    };
  };
  // pdfjs wants a Uint8Array, not a Node Buffer wrapper. Convert by
  // creating a view over a copied ArrayBuffer (avoid SharedArrayBuffer
  // / detached-buffer issues from Buffer's underlying pool).
  const u8 = new Uint8Array(bytes.byteLength);
  u8.set(bytes);
  const doc = await pdfjs.getDocument({ data: u8 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map(item => (typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push(`--- Page ${i} ---\n${text}`);
  }
  const joined = pages.join('\n\n');
  return {
    blocks: [
      {
        type: 'text',
        text:
          `PDF (text extracted, ${doc.numPages} page(s)):\n\n${joined}\n\n` +
          `NOTE: This PDF was text-extracted. If the architecture / flow is ` +
          `expressed as a diagram image, drop the diagram separately as PNG/JPG ` +
          `so the model can see it.`,
      },
    ],
    summary: `pdf · ${doc.numPages} page(s) · ${formatBytes(joined.length)} text`,
  };
}
