// Unit tests for extension/lib/helia.js against tests/fixtures/helia-backend-double.mjs (a MOCK of the proposed
// Thirstt-backend /helia endpoints, on real sockets). The add-on never talks to the sidecar itself.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  createHeliaClient, isValidCid, HeliaError, HeliaUnavailable, HeliaTimeout, HeliaLoginRequired,
  HeliaInvalidCid, HeliaPayloadTooLarge, HeliaNotFound,
} from '../../extension/lib/helia.js';
import { createBackendDouble, rawCid } from '../fixtures/helia-backend-double.mjs';

let double, base;
const GOOD_CID = rawCid(Buffer.from('anything'));
// Node's fetch has no cookie jar: stand in for the browser sending the add-on's Thirstt session cookie.
const withSession = (extra = {}) => (url, init) => fetch(url, { ...init, headers: { ...init.headers, Cookie: 'mock_session=1', ...extra } });
const client = (opts = {}) => createHeliaClient({ baseUrl: base, fetchImpl: withSession(), ...opts });

before(async () => { double = createBackendDouble({ maxUpload: 1024 }); base = await double.listen(); });
after(async () => { await double.close(); });
beforeEach(() => { double.state.mode = null; double.state.requests.length = 0; double.state.store.clear(); });

async function closedPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// ---- success ---------------------------------------------------------------------------------------------
test('put returns a CID and get returns the same bytes', async () => {
  const c = client();
  const cid = await c.put(new TextEncoder().encode('hello helia'));
  assert.ok(isValidCid(cid));
  assert.equal(cid, rawCid(Buffer.from('hello helia')));
  assert.equal(new TextDecoder().decode(await c.get(cid)), 'hello helia');
  const bin = Uint8Array.from({ length: 700 }, (_, i) => i % 256);
  assert.deepEqual(await c.get(await c.put(bin)), bin);
});

test('uploads always carry Content-Type: application/octet-stream (the sidecar silently stores nothing without it)', async () => {
  await client().put(new Uint8Array([1, 2, 3]));
  assert.equal(double.state.requests.find((r) => r.method === 'POST').contentType, 'application/octet-stream');
});

test('requests use the session cookie, no cache, no referrer, and never follow redirects', async () => {
  let seen;
  const spy = async (url, init) => { seen = init; return withSession()(url, init); };
  await createHeliaClient({ baseUrl: base, fetchImpl: spy }).put(new Uint8Array([9]));
  assert.equal(seen.credentials, 'include');
  assert.equal(seen.cache, 'no-store');
  assert.equal(seen.referrerPolicy, 'no-referrer');
  assert.equal(seen.redirect, 'error');
});

test('health is true when storage answers, false for any failure (and never throws)', async () => {
  assert.equal(await client().health(), true);
  double.state.mode = 503;
  assert.equal(await client().health(), false);
  double.state.mode = 'hang';
  assert.equal(await client({ timeoutMs: 200 }).health(), false);
  assert.equal(await createHeliaClient({ baseUrl: `http://127.0.0.1:${await closedPort()}`, fetchImpl: withSession() }).health(), false);
});

// ---- 502 -------------------------------------------------------------------------------------------------
test('unreachable and 502/503 are HeliaUnavailable (502)', async () => {
  const down = createHeliaClient({ baseUrl: `http://127.0.0.1:${await closedPort()}`, fetchImpl: withSession() });
  await assert.rejects(down.put(new Uint8Array([1])), (e) => e instanceof HeliaUnavailable && e.status === 502);
  await assert.rejects(down.get(GOOD_CID), HeliaUnavailable);
  for (const status of [502, 503]) {
    double.state.mode = status;
    await assert.rejects(client().put(new Uint8Array([1])), (e) => e instanceof HeliaUnavailable && e.status === 502);
    await assert.rejects(client().get(GOOD_CID), HeliaUnavailable);
  }
});

test('a redirect is refused (the session cookie must not follow it) and nothing else is requested', async () => {
  double.state.mode = 'redirect';
  await assert.rejects(client().put(new Uint8Array([1])), HeliaUnavailable);
  assert.equal(double.state.requests.length, 1);
});

test('a reply that ended up on another origin is never processed', async () => {
  const evil = async () => { const r = new Response('{"cid":"x"}', { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://evil.invalid/x' }); return r; };
  await assert.rejects(createHeliaClient({ baseUrl: 'https://api.example.invalid', fetchImpl: evil }).get(GOOD_CID),
    (e) => e instanceof HeliaError && /Unexpected/.test(e.message));
});

// ---- 504 -------------------------------------------------------------------------------------------------
test('504 and a really hung backend are HeliaTimeout (504)', async () => {
  double.state.mode = 504;
  await assert.rejects(client().get(GOOD_CID), (e) => e instanceof HeliaTimeout && e.status === 504);
  double.state.mode = 'hang';
  const started = Date.now();
  await assert.rejects(client({ timeoutMs: 300 }).put(new Uint8Array([1])), HeliaTimeout);
  await assert.rejects(client({ timeoutMs: 300 }).get(GOOD_CID), HeliaTimeout);
  assert.ok(Date.now() - started < 3000, 'timed out fast');
});

test('an unknown CID is a 504 like the real offline sidecar', async () => {
  await assert.rejects(client().get(rawCid(Buffer.from('never stored'))), HeliaTimeout);
});

// ---- invalid CID -----------------------------------------------------------------------------------------
test('invalid CIDs are refused locally without any request', async () => {
  const bad = ['', 'Qm', '../../etc/passwd', 'bafy/../x', `${GOOD_CID}\n`, GOOD_CID.toUpperCase(), `Qm${'0'.repeat(44)}`,
    `b${'1'.repeat(30)}`, ` ${GOOD_CID}`, `${GOOD_CID}?x=1`, 'http://evil.invalid/', null, undefined, 5, {}];
  for (const value of bad) await assert.rejects(client().get(value), (e) => e instanceof HeliaInvalidCid && e.status === 400, String(value));
  assert.equal(double.state.requests.length, 0);
});

test('a 400 from the backend is HeliaInvalidCid too', async () => {
  double.state.mode = 400;
  await assert.rejects(client().get(GOOD_CID), HeliaInvalidCid);
});

// ---- oversize --------------------------------------------------------------------------------------------
test('an oversized upload is refused locally (413) before any request', async () => {
  const c = client({ maxUploadBytes: 1024 });
  await assert.rejects(c.put(new Uint8Array(1025)), (e) => e instanceof HeliaPayloadTooLarge && e.status === 413);
  assert.equal(double.state.requests.length, 0);
  assert.ok(await c.put(new Uint8Array(1024).fill(7)));         // exactly the limit is fine
});

test('a 413 from the backend is HeliaPayloadTooLarge', async () => {
  await assert.rejects(client({ maxUploadBytes: 100_000 }).put(new Uint8Array(2000)), HeliaPayloadTooLarge);   // the backend's limit is 1024
});

test('empty and non-byte payloads are refused', async () => {
  await assert.rejects(client().put(new Uint8Array(0)), RangeError);
  for (const bad of ['text', 5, null, [1, 2]]) await assert.rejects(client().put(bad), TypeError);
  assert.ok(await client().put(new Uint8Array([1]).buffer));    // an ArrayBuffer is accepted
});

test('a download over the limit is refused, by Content-Length and by counting bytes', async () => {
  double.state.mode = 'huge';                                   // the double streams 6 MiB
  await assert.rejects(client({ maxDownloadBytes: 1024 * 1024 }).get(GOOD_CID), (e) => e instanceof HeliaError && /too large/.test(e.message));
  const lying = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5000)); c.close(); } }), { status: 200, headers: { 'content-length': '10' } });
  await assert.rejects(createHeliaClient({ baseUrl: base, fetchImpl: lying, maxDownloadBytes: 1000 }).get(GOOD_CID), /too large/);
});

// ---- auth and other failure shapes -----------------------------------------------------------------------
test('401/403 mean "log in to Thirstt first" (HeliaLoginRequired)', async () => {
  await assert.rejects(createHeliaClient({ baseUrl: base }).put(new Uint8Array([1])), (e) => e instanceof HeliaLoginRequired && e.status === 401);   // no cookie
  double.state.mode = 403;
  await assert.rejects(client().get(GOOD_CID), HeliaLoginRequired);
});

test('404 is HeliaNotFound; any other status is a plain HeliaError', async () => {
  double.state.mode = 404;
  await assert.rejects(client().get(GOOD_CID), HeliaNotFound);
  double.state.mode = 500;
  await assert.rejects(client().put(new Uint8Array([1])), (e) => e.constructor === HeliaError && e.status === 500);
});

test('malformed upload replies are rejected, not trusted', async () => {
  for (const mode of ['bad-json', 'bad-cid']) {
    double.state.mode = mode;
    await assert.rejects(client().put(new Uint8Array([1])), HeliaError, mode);
  }
});

// ---- construction: the add-on can never hold the sidecar secret ------------------------------------------
test('there is nowhere to put a sidecar secret, and nothing else unknown is accepted', () => {
  for (const key of ['secret', 'token', 'sidecarSecret', 'authKey', 'password', 'apiKey']) {
    assert.throws(() => createHeliaClient({ baseUrl: base, [key]: 'x' }), /never be given a sidecar secret/, key);
  }
  assert.throws(() => createHeliaClient({ baseUrl: base, surprise: 1 }), /Unknown option/);
});

test('the base URL must be https (loopback http only for the local test double) and the prefix a plain path', () => {
  assert.ok(createHeliaClient({ baseUrl: 'https://api.example.invalid' }));
  assert.ok(createHeliaClient({ baseUrl: 'http://127.0.0.1:1' }));
  assert.ok(createHeliaClient({ baseUrl: base, prefix: '/meshkit-helia/v1' }));
  for (const bad of ['http://api.example.invalid', 'ftp://x', 'javascript:1', 'not a url', '']) assert.throws(() => createHeliaClient({ baseUrl: bad }), /https/, bad);
  for (const bad of ['no-slash', '/a b', '/a?x=1', '//evil.invalid', '/../x', '/a/../b', '/.hidden', '/a//b', '/', '']) assert.throws(() => createHeliaClient({ baseUrl: base, prefix: bad }), /prefix/, bad);
});

// ---- static guarantees: scaffold only, no secret, background only ----------------------------------------
function files(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
}
const code = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('helia.js never sets a sidecar header or any Authorization', () => {
  const text = code('extension/lib/helia.js');
  assert.doesNotMatch(text, /X-Meshkit|Authorization|Bearer/i);
  assert.doesNotMatch(text, /5052|meshkit/i, 'it must not know the sidecar port or name');
});

test('the scaffold is not wired: no other shipped file mentions helia, and the manifest is unchanged by it', () => {
  for (const f of files('extension').filter((n) => /\.(js|html|json|css)$/.test(n) && !n.endsWith('lib/helia.js'))) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /helia/i, f);
  }
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions.length, 1);
});
