// Opt-in: the add-on's Helia client -> a stand-in Thirstt backend (holds the secret) -> the REAL Helia sidecar.
// Skipped unless HELIA_SIDECAR_URL is set.
//
//   export HELIA_SIDECAR_SECRET=$(openssl rand -hex 32)
//   docker compose -f tests/integration/docker-compose.helia.yml up -d --build --wait
//   HELIA_SIDECAR_URL=http://127.0.0.1:5052 npm run test:integration
//   docker compose -f tests/integration/docker-compose.helia.yml down -v
//
// HELIA_MAX_UPLOAD_MB must match the sidecar's (the compose file uses 1). Takes ~10 s: one test waits for the
// sidecar's own 5 s retrieve timeout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createHeliaClient, isValidCid, HeliaTimeout, HeliaUnavailable, HeliaLoginRequired, HeliaPayloadTooLarge, HeliaInvalidCid } from '../../extension/lib/helia.js';
import { createThirsttBackendDouble } from './thirstt-backend-double.mjs';
import { rawCid } from '../fixtures/helia-backend-double.mjs';

const URL_ = (process.env.HELIA_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
const SECRET = process.env.HELIA_SIDECAR_SECRET ?? '';
const LIMIT = Math.round(Number(process.env.HELIA_MAX_UPLOAD_MB ?? '1') * 1024 * 1024);
const opts = { skip: URL_ ? false : 'set HELIA_SIDECAR_URL (and HELIA_SIDECAR_SECRET) to run against the real sidecar' };

let backend, base, deadBackend, deadBase;
const withSession = (seen) => (url, init) => {
  seen?.push({ url, init });
  return fetch(url, { ...init, headers: { ...init.headers, Cookie: 'mock_session=1' } });
};
const client = (o = {}) => createHeliaClient({ baseUrl: base, fetchImpl: withSession(), maxUploadBytes: 2 * LIMIT, ...o });

before(async () => {
  if (!URL_) return;
  backend = createThirsttBackendDouble({ sidecarUrl: URL_, secret: SECRET, maxUpload: LIMIT });
  base = await backend.listen();
  const s = createServer();                                     // a port with nothing listening: the "sidecar is down" case
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${s.address().port}`;
  await new Promise((r) => s.close(r));
  deadBackend = createThirsttBackendDouble({ sidecarUrl: dead, secret: SECRET });
  deadBase = await deadBackend.listen();
});
after(async () => { await backend?.close(); await deadBackend?.close(); });

test('health goes client -> backend -> real sidecar', opts, async () => {
  assert.equal(await client().health(), true);
});

test('put/get round trip through the chain; a small payload gets the CID computed locally', opts, async () => {
  const data = new TextEncoder().encode(`thirstt-addon/helia integration test ${randomBytes(8).toString('hex')}`);
  const cid = await client().put(data);
  console.log(`  put ${data.byteLength} bytes -> ${cid}`);
  assert.ok(isValidCid(cid));
  assert.equal(cid, rawCid(Buffer.from(data)), 'one-chunk payload => raw-leaf CIDv1 sha2-256');
  assert.deepEqual(await client().get(cid), data);
  assert.equal(await client().put(data), cid);                 // same bytes, same CID
});

test('binary payload near the limit round-trips', opts, async () => {
  const data = new Uint8Array(randomBytes(LIMIT - 1024));
  assert.deepEqual(await client().get(await client().put(data)), data);
});

test('an unknown CID is HeliaTimeout (504) after the sidecar\'s own 5 s timeout', opts, async () => {
  const started = Date.now();
  await assert.rejects(client().get(rawCid(randomBytes(32))), (e) => e instanceof HeliaTimeout && e.status === 504);
  const took = (Date.now() - started) / 1000;
  console.log(`  unknown CID -> HeliaTimeout (504) after ${took.toFixed(1)}s`);
  assert.ok(took >= 4 && took < 8);
});

test('not logged in to Thirstt: HeliaLoginRequired (401), whatever the sidecar would say', opts, async () => {
  await assert.rejects(createHeliaClient({ baseUrl: base }).put(new Uint8Array([1])), HeliaLoginRequired);
});

test('sidecar down behind the backend: HeliaUnavailable (502), health false', opts, async () => {
  const c = createHeliaClient({ baseUrl: deadBase, fetchImpl: withSession() });
  await assert.rejects(c.put(new Uint8Array([1])), (e) => e instanceof HeliaUnavailable && e.status === 502);
  await assert.rejects(c.get(rawCid(randomBytes(32))), HeliaUnavailable);
  assert.equal(await c.health(), false);
});

test('invalid CID: refused locally, and the backend also answers 400', opts, async () => {
  await assert.rejects(client().get('not-a-cid'), HeliaInvalidCid);
  const r = await fetch(`${base}/helia/retrieve/not-a-cid`, { headers: { Cookie: 'mock_session=1' } });
  console.log(`  backend itself, GET /helia/retrieve/not-a-cid -> ${r.status} ${await r.text()}`);
  assert.equal(r.status, 400);
});

test('oversized upload: refused locally, and the backend answers 413', opts, async () => {
  await assert.rejects(createHeliaClient({ baseUrl: base, fetchImpl: withSession(), maxUploadBytes: LIMIT }).put(new Uint8Array(LIMIT + 1)), HeliaPayloadTooLarge);
  await assert.rejects(client().put(new Uint8Array(LIMIT + 1)), (e) => e instanceof HeliaPayloadTooLarge && e.status === 413);   // client limit raised: the backend refuses
});

test('the add-on never sees or sends the sidecar secret', opts, async () => {
  const seen = [];
  const c = createHeliaClient({ baseUrl: base, fetchImpl: withSession(seen) });
  const cid = await c.put(new Uint8Array([4, 2]));
  await c.get(cid);
  await c.health();
  assert.ok(seen.length >= 3);
  assert.ok(SECRET.length >= 16, 'the test needs a real secret to look for');
  for (const { url, init } of seen) {
    assert.ok(!JSON.stringify(init.headers ?? {}).toLowerCase().includes('x-meshkit'), url);
    assert.ok(!JSON.stringify(init).includes(SECRET), url);
  }
  const r = await fetch(`${base}/helia/health`, { headers: { Cookie: 'mock_session=1' } });
  assert.ok(!JSON.stringify([...r.headers]).includes(SECRET) && !(await r.text()).includes(SECRET));
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk('extension')) assert.ok(!readFileSync(f).includes(SECRET), `${f} contains the secret`);
});

test('the sidecar itself: an upload with no Content-Type should not silently store nothing',
  { ...opts, todo: 'upstream sidecar bug, fixed in Tornado-Backend-Stack#15 (a114973); fails against older sidecar builds (200 with the EMPTY-file CID). The add-on client always sends application/octet-stream.' },
  async () => {
    const r = await fetch(`${URL_}/upload`, { method: 'POST', body: new Uint8Array([104, 105]), headers: { 'X-Meshkit-Helia-Token': SECRET, 'Content-Type': '' } });
    const reply = r.status === 200 ? await r.json() : null;
    assert.ok(r.status !== 200 || reply.cid === rawCid(Buffer.from('hi')), `got ${r.status} ${JSON.stringify(reply)}`);
  });
