import {
  extractDrawio,
  extractExcalidraw,
  extractFromUpload,
} from '../src/server/file-extractor';

describe('extractFromUpload — type dispatch', () => {
  it('routes PNG bytes to the image branch with proper base64', async () => {
    const png = Buffer.from('fake png bytes');
    const res = await extractFromUpload('diagram.png', 'image/png', png);
    expect(res.blocks).toHaveLength(1);
    const b = res.blocks[0];
    expect(b.type).toBe('image');
    if (b.type !== 'image') throw new Error();
    expect(b.mediaType).toBe('image/png');
    expect(b.base64).toBe(png.toString('base64'));
  });

  it('guesses mime from extension when none provided', async () => {
    const res = await extractFromUpload('shot.jpg', '', Buffer.from('x'));
    expect(res.blocks[0].type).toBe('image');
    if (res.blocks[0].type !== 'image') throw new Error();
    expect(res.blocks[0].mediaType).toBe('image/jpeg');
  });

  it('passes plain text through unchanged', async () => {
    const res = await extractFromUpload(
      'spec.md',
      'text/markdown',
      Buffer.from('# Hello\n\nThe agent does X.'),
    );
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0]).toMatchObject({
      type: 'text',
      text: '# Hello\n\nThe agent does X.',
    });
  });

  it('accepts application/json as a text block (the auditspec case)', async () => {
    const json = '{"commits":["abc123"],"tickets":{"DEV-1":"fix"}}';
    const res = await extractFromUpload('auditspec.json', 'application/json', Buffer.from(json));
    expect(res.blocks).toHaveLength(1);
    expect(res.blocks[0]).toMatchObject({ type: 'text', text: json });
  });

  it('accepts a .json extension even when the mime is generic', async () => {
    const json = '[1,2,3]';
    const res = await extractFromUpload('data.json', 'application/octet-stream', Buffer.from(json));
    expect(res.blocks[0]).toMatchObject({ type: 'text', text: json });
  });

  it('accepts YAML / CSV text-bearing data formats', async () => {
    const yaml = await extractFromUpload('cfg.yaml', 'application/x-yaml', Buffer.from('a: 1'));
    expect(yaml.blocks[0]).toMatchObject({ type: 'text', text: 'a: 1' });
    const csv = await extractFromUpload('rows.csv', 'text/csv', Buffer.from('a,b\n1,2'));
    expect(csv.blocks[0]).toMatchObject({ type: 'text', text: 'a,b\n1,2' });
  });

  it('rejects unsupported types with a friendly error', async () => {
    await expect(
      extractFromUpload('archive.zip', 'application/zip', Buffer.from([0])),
    ).rejects.toThrow(/Unsupported/);
  });
});

describe('extractDrawio', () => {
  it('parses a plain (uncompressed) drawio file into nodes + edges', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile>
  <diagram>
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="spec" vertex="1" parent="1" />
        <mxCell id="3" value="plan" vertex="1" parent="1" />
        <mxCell id="4" value="implement" vertex="1" parent="1" />
        <mxCell id="e1" edge="1" source="2" target="3" parent="1" />
        <mxCell id="e2" edge="1" source="3" target="4" parent="1" value="handoff" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
    const res = await extractDrawio(Buffer.from(xml));
    expect(res.blocks).toHaveLength(1);
    const text = (res.blocks[0] as { text: string }).text;
    expect(text).toContain('Nodes (3)');
    expect(text).toContain('"spec"');
    expect(text).toContain('"plan"');
    expect(text).toContain('"implement"');
    expect(text).toContain('Edges (2)');
    expect(text).toContain('spec → plan');
    expect(text).toContain('plan → implement [label: handoff]');
    expect(res.summary).toContain('3 nodes');
    expect(res.summary).toContain('2 edges');
  });

  it('strips HTML-style markup drawio embeds in cell values', async () => {
    const xml = `<mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="2" value="&lt;b&gt;spec&lt;/b&gt;" vertex="1" parent="0" />
      </root>
    </mxGraphModel>`;
    const res = await extractDrawio(Buffer.from(xml));
    const text = (res.blocks[0] as { text: string }).text;
    expect(text).toContain('"spec"');
    expect(text).not.toContain('<b>');
  });

  it('falls back to raw text when the file has no recognizable wrapper', async () => {
    const bogus = Buffer.from('<notXmlAtAll>random</notXmlAtAll>');
    const res = await extractDrawio(bogus);
    // The fallback emits the raw text as a block.
    expect(res.blocks[0]).toMatchObject({ type: 'text' });
  });
});

describe('extractExcalidraw', () => {
  it('parses shapes + arrows into a labeled graph', async () => {
    const scene = {
      type: 'excalidraw',
      version: 2,
      elements: [
        // Shapes
        { id: 'r1', type: 'rectangle', text: 'spec' },
        { id: 'r2', type: 'rectangle', text: '' }, // label via container binding
        { id: 'r3', type: 'ellipse', text: 'review' },
        // Text bound to r2
        { id: 't1', type: 'text', text: 'plan', containerId: 'r2' },
        // Arrows
        {
          id: 'a1',
          type: 'arrow',
          startBinding: { elementId: 'r1' },
          endBinding: { elementId: 'r2' },
        },
        {
          id: 'a2',
          type: 'arrow',
          startBinding: { elementId: 'r2' },
          endBinding: { elementId: 'r3' },
          boundElements: [{ id: 'tArrow', type: 'text' }],
        },
        { id: 'tArrow', type: 'text', text: 'handoff' },
      ],
    };
    const res = await extractExcalidraw(Buffer.from(JSON.stringify(scene)));
    const text = (res.blocks[0] as { text: string }).text;
    expect(text).toContain('Nodes (3)');
    expect(text).toContain('"spec"');
    expect(text).toContain('"plan"');
    expect(text).toContain('"review"');
    expect(text).toContain('Edges (2)');
    expect(text).toContain('spec → plan');
    expect(text).toContain('plan → review [label: handoff]');
  });

  it('rejects non-JSON .excalidraw bytes with a clear error', async () => {
    await expect(
      extractExcalidraw(Buffer.from('not json')),
    ).rejects.toThrow(/JSON/);
  });

  it('rejects valid JSON that lacks an elements array', async () => {
    await expect(
      extractExcalidraw(Buffer.from(JSON.stringify({ ok: true }))),
    ).rejects.toThrow(/elements/);
  });
});
