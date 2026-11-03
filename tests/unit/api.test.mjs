// Unit tests for the API client with fetch replaced by a stub. The response bodies for the "ok" case come from
// tests/fixtures/extract-ok.json, a labelled test double (NOT real Thirstt data; see tests/fixtures/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchExtract, login, extractUrl, ApiError } from '../../extension/lib/api.js';

const FIXTURE = readFileSync(new URL('../fixtures/extract-ok.json', import.meta.url), 'utf8');
const reply = (status, body = '') => async () => new Response(body, { status });
const BASE = 'https://api.example.invalid';

test('extractUrl percent-encodes the page URL (no query/fragment smuggling)', () => {
  const u = extractUrl(BASE, 'https://a.invalid/p?x=1&y=2#frag');
  assert.equal(u, `${BASE}/mediaservice/fetchExtract?url=https%3A%2F%2Fa.invalid%2Fp%3Fx%3D1%26y%3D2%23frag`);
  assert.equal(new URL(u).searchParams.get('url'), 'https://a.invalid/p?x=1&y=2#frag');
});

test('fetchExtract: valid JSON -> ok with title and content', async () => {
  const r = await fetchExtract(BASE, 'https://a.invalid/', { fetchImpl: reply(200, FIXTURE) });
  assert.equal(r.status, 'ok');
  assert.equal(typeof r.title, 'string');
  assert.ok(r.content.length > 0);
});

test('fetchExtract: non-JSON 200 (a login page), 401, 403 and empty/odd JSON all mean login-required', async () => {
  for (const f of [reply(200, '<html>login</html>'), reply(401), reply(403), reply(200, '[]'), reply(200, '{}'), reply(200, '[1]')]) {
    assert.deepEqual(await fetchExtract(BASE, 'https://a.invalid/', { fetchImpl: f }), { status: 'login-required' });
  }
});

test('fetchExtract: other HTTP errors and network failures throw ApiError with a safe message', async () => {
  await assert.rejects(fetchExtract(BASE, 'x', { fetchImpl: reply(500) }), (e) => e instanceof ApiError && /500/.test(e.message));
  await assert.rejects(fetchExtract(BASE, 'x', { fetchImpl: async () => { throw new TypeError('NetworkError secret-host'); } }),
    (e) => e instanceof ApiError && e.message === 'Could not reach Thirstt.');
});

test('fetchExtract: a stalled request times out', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const keepAlive = setTimeout(() => {}, 2000);   // Node's AbortSignal.timeout timer is unref'd; keep the loop alive
  try {
    await assert.rejects(fetchExtract(BASE, 'x', { fetchImpl: hang, timeoutMs: 50 }), (e) => e instanceof ApiError && /timed out/.test(e.message));
  } finally { clearTimeout(keepAlive); }
});

test('requests carry the session cookie, are never cached and send no referrer', async () => {
  let seen;
  await fetchExtract(BASE, 'x', { fetchImpl: async (u, init) => { seen = init; return new Response('[]'); } });
  assert.equal(seen.credentials, 'include');
  assert.equal(seen.cache, 'no-store');
  assert.equal(seen.referrerPolicy, 'no-referrer');
});

test('login: success, wrong password, and unreachable', async () => {
  assert.equal(await login(BASE, 'a@example.invalid', 'pw', { fetchImpl: reply(200) }), true);
  for (const code of [400, 401, 403]) assert.equal(await login(BASE, 'a@example.invalid', 'pw', { fetchImpl: reply(code) }), false);
  await assert.rejects(login(BASE, 'a', 'b', { fetchImpl: reply(502) }), ApiError);
});

test('login posts JSON to /login and nothing else leaks into the URL', async () => {
  let url, init;
  await login(BASE, 'a@example.invalid', 'pw', { fetchImpl: async (u, i) => { url = u; init = i; return new Response('', { status: 200 }); } });
  assert.equal(url, `${BASE}/login`);
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { email: 'a@example.invalid', password: 'pw', isJson: 1 });
});
