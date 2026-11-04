// TEST DOUBLE standing in for the PROPOSED Thirstt backend /helia endpoints, in front of the REAL Helia sidecar.
// It does what the real backend would have to do: authorise the user (here: the mock session cookie), validate, and
// forward with the sidecar's shared secret, which lives ONLY here (never in the add-on). Not real Thirstt code.
import { createServer } from 'node:http';

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

export function createThirsttBackendDouble({ sidecarUrl, secret, maxUpload = 1024 * 1024, sidecarTimeoutMs = 8000 }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size <= maxUpload + 1) chunks.push(c); }
    const send = (status, body, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };

    if (!(req.headers.cookie ?? '').includes('mock_session=1')) return send(401, '{"error":"login required"}');

    async function forward(method, path, body) {
      try {
        const r = await fetch(sidecarUrl + path, {
          method, body,
          headers: { 'X-Meshkit-Helia-Token': secret, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
          signal: AbortSignal.timeout(sidecarTimeoutMs), redirect: 'error',
        });
        if (r.status === 401) return send(502, '{"error":"sidecar_misconfigured"}');       // our own secret was rejected: not the user's fault
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) {
        send(e?.name === 'TimeoutError' ? 504 : 502, JSON.stringify({ error: e?.name === 'TimeoutError' ? 'timeout' : 'sidecar unreachable' }));
      }
    }

    if (url.pathname === '/helia/health') return forward('GET', '/health');
    if (url.pathname === '/helia/upload' && req.method === 'POST') {
      if (size > maxUpload) return send(413, '{"error":"payload_too_large"}');
      return forward('POST', '/upload', Buffer.concat(chunks));
    }
    const m = /^\/helia\/retrieve\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const cid = decodeURIComponent(m[1]);
      if (!CID.test(cid)) return send(400, '{"error":"invalid CID"}');
      return forward('GET', `/retrieve/${encodeURIComponent(cid)}`);
    }
    send(404, '{"error":"no such route"}');
  });
  const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  const close = () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); };
  return { listen, close };
}
