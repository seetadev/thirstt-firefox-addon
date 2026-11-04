// SCAFFOLD: nothing imports this file yet (see HELIA_INTEGRATION.md). Client for stored content addressed by CID.
//
// The add-on must NEVER hold the Helia sidecar's shared secret: an extension is a zip that every user can unpack, so
// anything inside it is public. This client therefore does not talk to the sidecar. It talks to the THIRSTT BACKEND
// (HTTPS only, the user's session cookie), which authorises the user and forwards to the sidecar, where the secret
// lives. The backend endpoints below are a PROPOSAL; they do not exist yet.
//
//   put(bytes)  -> cid         POST {API_BASE}/helia/upload            raw bytes (application/octet-stream)  ->  {"cid"}
//   get(cid)    -> Uint8Array  GET  {API_BASE}/helia/retrieve/<cid>                                         ->  raw bytes
//   health()    -> boolean     GET  {API_BASE}/helia/health                                                 ->  {"status":"ok"}
//
// Use it from the BACKGROUND page only (it is the one place that holds the extension's cookie jar and the API
// permission); the panel and the content script must go through runtime messages.
//
// Errors mirror what the sidecar and the Tornado proxy produce, so callers can fall back uniformly:
//   unreachable / 502 / 503                          -> HeliaUnavailable (502)
//   too slow, or 504 (the sidecar answers 504 after 5 s for a CID it does not hold)   -> HeliaTimeout (504)
//   401 / 403 (not logged in to Thirstt)             -> HeliaLoginRequired (401)
//   malformed CID (checked locally first) / 400      -> HeliaInvalidCid (400)
//   payload over the limit (checked locally) / 413   -> HeliaPayloadTooLarge (413)
//   404                                              -> HeliaNotFound (404)
//   anything else, or a reply that breaks the contract -> HeliaError (500)
import { assertSecureBase } from './api.js';

export const DEFAULT_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;     // saved articles / clips are text; the backend sets the real limit
export const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
// Plain path segments only: no '//', no '.'/'..' or hidden segments.
const PREFIX = /^(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+\/?$/;

// The sidecar's two CID shapes: CIDv0 (base58btc, "Qm...", 46 chars) or CIDv1 (multibase "b" + lowercase base32).
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{20,}$/;
export const isValidCid = (value) => typeof value === 'string' && (CID_V0.test(value) || CID_V1.test(value));

export class HeliaError extends Error { status = 500; }
export class HeliaUnavailable extends HeliaError { status = 502; }
export class HeliaTimeout extends HeliaError { status = 504; }
export class HeliaLoginRequired extends HeliaError { status = 401; }
export class HeliaInvalidCid extends HeliaError { status = 400; }
export class HeliaPayloadTooLarge extends HeliaError { status = 413; }
export class HeliaNotFound extends HeliaError { status = 404; }

function fromStatus(code) {
  if (code === 400) return new HeliaInvalidCid('The request was rejected as invalid.');
  if (code === 401 || code === 403) return new HeliaLoginRequired('Log in to Thirstt first.');
  if (code === 404) return new HeliaNotFound('Not found.');
  if (code === 413) return new HeliaPayloadTooLarge('The upload was refused as too large.');
  if (code === 502 || code === 503) return new HeliaUnavailable(`Storage is unavailable (${code}).`);
  if (code === 504) return new HeliaTimeout('Storage timed out.');
  return new HeliaError(`Unexpected reply (${code}).`);
}

// Reads at most `limit` bytes; a bigger (or lying) response is refused instead of buffered.
async function readBytesLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HeliaError('The reply is too large.');
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.byteLength > limit) throw new HeliaError('The reply is too large.');
    return all;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new HeliaError('The reply is too large.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl  The THIRSTT backend origin (https://, or loopback http:// for the local test double).
 * @param {string} [options.prefix] Path prefix of the proposed endpoints (default "/helia").
 */
export function createHeliaClient({ baseUrl, prefix = '/helia', fetchImpl = fetch, timeoutMs = 8000,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES, ...rest } = {}) {
  // There is deliberately nowhere to put a sidecar secret. Fail loudly if someone tries.
  for (const key of Object.keys(rest)) {
    if (/secret|token|key|auth|password/i.test(key)) throw new HeliaError('The add-on must never be given a sidecar secret.');
    throw new HeliaError(`Unknown option: ${key}`);
  }
  let origin;
  try { origin = assertSecureBase(baseUrl).origin; } catch { throw new HeliaError('The Thirstt address must use https://.'); }
  if (!PREFIX.test(prefix)) throw new HeliaError('Invalid path prefix.');
  const base = origin + prefix.replace(/\/+$/, '');

  async function call(method, path, { body, limit } = {}) {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        body,
        headers: body ? { 'Content-Type': 'application/octet-stream' } : undefined,   // the sidecar drops bodies without it
        credentials: 'include',                       // the Thirstt session cookie (the add-on's own cookie jar)
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',                            // never follow a redirect with the session cookie
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw error?.name === 'TimeoutError' ? new HeliaTimeout('Storage timed out.') : new HeliaUnavailable('Could not reach Thirstt.');
    }
    if (response.url && new URL(response.url).origin !== origin) throw new HeliaError('Unexpected reply.');
    if (response.status !== 200) {
      try { await response.body?.cancel(); } catch { /* nothing more to read */ }
      throw fromStatus(response.status);
    }
    try {
      return await readBytesLimited(response, limit ?? maxDownloadBytes);
    } catch (error) {
      if (error instanceof HeliaError) throw error;
      throw error?.name === 'TimeoutError' ? new HeliaTimeout('Storage timed out.') : new HeliaUnavailable('Could not reach Thirstt.');
    }
  }

  return {
    /** Stores `bytes` (Uint8Array / ArrayBuffer) and resolves to its CID. */
    async put(bytes) {
      const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
      if (!(data instanceof Uint8Array)) throw new TypeError('put() takes a Uint8Array');
      if (data.byteLength === 0) throw new RangeError('put() refuses an empty payload');
      if (data.byteLength > maxUploadBytes) throw new HeliaPayloadTooLarge(`Upload is ${data.byteLength} bytes; the limit is ${maxUploadBytes}.`);
      const reply = await call('POST', '/upload', { body: data, limit: 64 * 1024 });
      let cid;
      try { cid = JSON.parse(new TextDecoder().decode(reply)).cid; } catch { cid = undefined; }
      if (!isValidCid(cid)) throw new HeliaError('The reply did not contain a valid CID.');
      return cid;
    },
    /** Resolves to the Uint8Array stored under `cid`. */
    async get(cid) {
      if (!isValidCid(cid)) throw new HeliaInvalidCid('Not a valid CID.');
      return call('GET', `/retrieve/${encodeURIComponent(cid)}`);
    },
    /** Resolves to true if storage answers its health check; false for any failure (never rejects). */
    async health() {
      try {
        return JSON.parse(new TextDecoder().decode(await call('GET', '/health', { limit: 64 * 1024 }))).status === 'ok';
      } catch { return false; }
    },
  };
}
