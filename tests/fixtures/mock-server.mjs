// TEST DOUBLE for the Thirstt API (see README.md in this directory). Not real data.
//   node tests/fixtures/mock-server.mjs [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_USER = { email: 'test-user@example.invalid', password: 'test-password-not-real' };
const COOKIE = 'mock_session=1';

export function createMock({ extractFixture = 'extract-ok.json' } = {}) {
  const state = { extractRequests: [], loginAttempts: [], extractFixture };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const loggedIn = (req.headers.cookie ?? '').includes(COOKIE);
    const send = (status, body, type = 'application/json', headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };

    if (url.pathname === '/mediaservice/fetchExtract') {
      state.extractRequests.push({ url: url.searchParams.get('url'), rawQuery: url.search, loggedIn });
      if (!loggedIn) return send(200, '<html><body>Please log in</body></html>', 'text/html');   // original "login" heuristic
      return send(200, readFileSync(join(here, state.extractFixture)));
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch { /* ignore */ }
        const ok = data.email === FAKE_USER.email && data.password === FAKE_USER.password;
        state.loginAttempts.push({ ok, isJson: data.isJson });
        if (ok) return send(200, '{"ok":true}', 'application/json', { 'Set-Cookie': `${COOKIE}; Path=/` });
        send(401, '{"ok":false}');
      });
      return;
    }
    if (url.pathname === '/register') return send(200, '<h1>Register (test double)</h1>', 'text/html');
    if (url.pathname.startsWith('/pages/')) {
      try { return send(200, readFileSync(join(here, url.pathname.slice(1))), 'text/html'); } catch { /* fallthrough */ }
    }
    if (url.pathname === '/__test__/state') return send(200, JSON.stringify(state));
    if (url.pathname === '/__test__/fixture') { state.extractFixture = url.searchParams.get('name'); return send(200, '{}'); }
    if (url.pathname === '/__test__/reset') { state.extractRequests.length = 0; state.loginAttempts.length = 0; return send(200, '{}'); }
    send(404, 'not found', 'text/plain');
  });
  return { server, state, FAKE_USER };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8780);
  createMock().server.listen(port, '127.0.0.1', () => console.log(`Thirstt TEST DOUBLE on http://127.0.0.1:${port}`));
}
