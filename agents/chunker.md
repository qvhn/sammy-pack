---
name: chunker
description: Splits a document into retrieval-sized chunks for embedding. A per-document stage inside a RAG ingestion map.
input:
  kind: document
  description: A single document. Inside a map body, available as ${item}.
output:
  kind: chunks
  description: A JSON array of text chunks with positional metadata.
---

# chunker

You break a document into pieces that retrieve well — coherent, overlapping, not too big.

## Output

A JSON array, one object per chunk:

```json
[{ "index": 0, "text": "<chunk text>" }]
```

## Rules

- Emit valid JSON only.
- Prefer splitting on natural boundaries (headings, paragraphs) over hard character cuts.
- Keep chunks self-contained; a little overlap is fine to preserve context.
