#!/usr/bin/env node
/**
 * demo/sink.mjs — a local stand-in for the systems an automation talks to,
 * so the add-on demos run with no outside accounts:
 *
 *   POST /notify                      a chat webhook (notify.onGate / onTerminal)
 *   POST /tickets                     a ticket tracker: files a ticket, returns its key
 *   POST /tickets/:key/attachments    the tracker's attachment endpoint (multipart)
 *   GET  /                            an inbox page showing everything received
 *
 *   node demo/sink.mjs            # listens on 127.0.0.1:5199 (SINK_PORT overrides)
 *
 * Nothing is persisted; restart it to clear the inbox.
 */
import http from 'node:http';

const PORT = Number(process.env.SINK_PORT) || 5199;
const items = [];
let ticketSeq = 0;

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Pull the parts out of a multipart body — enough for a demo, not a parser. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || '');
  if (!m) return [];
  const boundary = `--${m[1] || m[2]}`;
  return buf
    .toString('utf8')
    .split(boundary)
    .slice(1, -1)
    .map(raw => {
      const [head, ...rest] = raw.replace(/^\r\n/, '').split('\r\n\r\n');
      const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
      const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      return { name, filename, body };
    });
}

function record(kind, summary, detail) {
  items.unshift({ at: new Date().toLocaleTimeString(), kind, summary, detail });
  console.log(`[sink] ${kind}: ${summary}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const body = await readBody(req);
  const json = () => {
    try {
      return JSON.parse(body.toString('utf8') || '{}');
    } catch {
      return { raw: body.toString('utf8') };
    }
  };
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method === 'POST' && url.pathname === '/notify') {
    const b = json();
    record('notify', b.text ?? `${b.orchestration} → ${b.status}`, b);
    return send(200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/tickets') {
    const b = json();
    const key = `DEMO-${++ticketSeq}`;
    record('ticket', `${key} — ${b.title ?? '(untitled)'} [${b.severity ?? '?'}]`, { key, ...b });
    return send(201, { key, url: `http://127.0.0.1:${PORT}/#${key}` });
  }
  const att = /^\/tickets\/([^/]+)\/attachments$/.exec(url.pathname);
  if (req.method === 'POST' && att) {
    const parts = parseMultipart(body, req.headers['content-type']);
    const files = parts.filter(p => p.filename);
    for (const f of files) {
      record('attachment', `${att[1]} ← ${f.filename} (${f.body.length} bytes)`, { preview: f.body.slice(0, 4000) });
    }
    return send(200, files.map(f => ({ filename: f.filename, size: f.body.length })));
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>Demo inbox</title>
<style>
 body{font:14px system-ui,sans-serif;margin:24px;color:#111827;background:#f9fafb}
 h1{font-size:18px} .it{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin:8px 0}
 .k{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:4px;margin-right:6px}
 .notify{background:#fef3c7}.ticket{background:#dbeafe}.attachment{background:#dcfce7}
 pre{white-space:pre-wrap;font-size:12px;background:#f3f4f6;padding:8px;border-radius:6px;max-height:280px;overflow:auto}
 .t{color:#6b7280;font-size:12px;float:right}
</style>
<h1>Demo inbox <span class="t">chat webhook · ticket tracker · attachments — refreshes every 2s</span></h1>
${items.length === 0 ? '<p>Nothing yet.</p>' : ''}
${items
  .map(
    i => `<div class="it"><span class="t">${esc(i.at)}</span><span class="k ${i.kind}">${esc(i.kind)}</span>${esc(i.summary)}
<pre>${esc(typeof i.detail?.preview === 'string' ? i.detail.preview : JSON.stringify(i.detail, null, 2))}</pre></div>`,
  )
  .join('')}`);
  }
  send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sink] demo inbox on http://127.0.0.1:${PORT}/`);
});
