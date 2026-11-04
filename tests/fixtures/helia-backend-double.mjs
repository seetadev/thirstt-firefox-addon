// TEST DOUBLE of the PROPOSED Thirstt-backend /helia endpoints (they do not exist yet). NOT real Thirstt and not the
// real sidecar: it stores bytes in memory and computes CIDs locally as CIDv1/raw/sha2-256 (what a one-chunk payload
// gets from the real sidecar; the opt-in integration test checks that). Authorisation is the mock session cookie.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export const rawCid = (data) => 'b' + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), createHash('sha256').update(data).digest()]));

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

export function createBackendDouble({ maxUpload = 1024 } = {}) {
  const state = { store: new Map(), requests: [], mode: null };   // mode: null | number | 'hang' | 'redirect' | 'bad-json' | 'bad-cid' | 'huge'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    state.requests.push({ method: req.method, path: url.pathname, contentType: req.headers['content-type'] ?? null, cookie: req.headers.cookie ?? null });
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (state.mode === 'hang') return;                           // never answers
    if (state.mode === 'redirect') { res.writeHead(302, { Location: 'http://elsewhere.invalid/' }); return res.end(); }
    if (!(req.headers.cookie ?? '').includes('mock_session=1')) return json(401, { error: 'login required' });
    if (typeof state.mode === 'number') return json(state.mode, { error: `forced ${state.mode}` });

    if (url.pathname === '/helia/health') return json(200, { status: 'ok' });
    if (url.pathname === '/helia/upload' && req.method === 'POST') {
      if (body.length > maxUpload) return json(413, { error: 'payload_too_large' });
      const cid = rawCid(body);
      state.store.set(cid, body);
      if (state.mode === 'bad-json') { res.writeHead(200); return res.end('<html>nope</html>'); }
      if (state.mode === 'bad-cid') return json(200, { cid: '../../etc/passwd' });
      return json(200, { cid });
    }
    const m = /^\/helia\/retrieve\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const cid = decodeURIComponent(m[1]);
      if (!CID.test(cid)) return json(400, { error: 'invalid CID' });
      if (state.mode === 'huge') { res.writeHead(200); return res.end(Buffer.alloc(6 * 1024 * 1024, 1)); }
      if (!state.store.has(cid)) return json(504, { error: 'retrieve timed out after 5s' });   // offline sidecar: unknown CID
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(state.store.get(cid));
    }
    json(404, { error: 'no such route' });
  });
  const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  const close = () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
  return { server, state, listen, close };
}
