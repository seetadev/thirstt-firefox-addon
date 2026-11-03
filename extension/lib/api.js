// Thin client for the Thirstt backend. Nothing here logs; credentials and responses are never written
// to the console.

export class ApiError extends Error {}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;   // an extract is an article, not a download
const MAX_TITLE_CHARS = 500;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The API must be HTTPS. Plain http is allowed only for a loopback host (the local test double). */
export function assertSecureBase(apiBase) {
  let url;
  try { url = new URL(apiBase); } catch { throw new ApiError('The Thirstt address is not valid.'); }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url;
  throw new ApiError('The Thirstt address must use https://.');
}

// Reads at most `limit` bytes of the body; a bigger (or lying) response is refused instead of buffered.
async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new ApiError('Thirstt sent a response that is too large.');
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); throw new ApiError('Thirstt sent a response that is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function extractUrl(apiBase, pageUrl) {
  return `${apiBase}${extractPath(pageUrl)}`;
}

const extractPath = (pageUrl) => `/mediaservice/fetchExtract?url=${encodeURIComponent(pageUrl)}`;

async function request(apiBase, path, init, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const base = assertSecureBase(apiBase);
  let response;
  try {
    response = await fetchImpl(`${base.origin}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs),
      ...init,
    });
  } catch (error) {
    throw new ApiError(error?.name === 'TimeoutError' ? 'The request timed out.' : 'Could not reach Thirstt.');
  }
  // A redirect may be followed, but nothing from another origin is ever processed.
  if (response.url && new URL(response.url).origin !== base.origin) throw new ApiError('Thirstt sent an unexpected reply.');
  return response;
}

/**
 * Resolves to { status: 'ok', title, content } or { status: 'login-required' }.
 * Like the original add-on, a reply that is not the expected JSON (typically a login page) means
 * "log in first"; 401/403 do too. Any other failure throws ApiError.
 */
export async function fetchExtract(apiBase, pageUrl, options) {
  const response = await request(apiBase, extractPath(pageUrl), { method: 'GET' }, options);
  if (response.status === 401 || response.status === 403) return { status: 'login-required' };
  if (!response.ok) throw new ApiError(`Thirstt returned an error (${response.status}).`);
  const text = await readLimited(response, MAX_RESPONSE_BYTES);   // outside the try: "too large" must not look like "log in"
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: 'login-required' };
  }
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || typeof first !== 'object') return { status: 'login-required' };
  return {
    status: 'ok',
    title: typeof first.title === 'string' ? first.title.slice(0, MAX_TITLE_CHARS) : '',
    content: typeof first.content === 'string' && first.content ? first.content : 'No content available for this webpage',
  };
}

/** Resolves to true on success, false for a wrong e-mail/password; throws ApiError if unreachable. */
export async function login(apiBase, email, password, options) {
  const response = await request(apiBase, '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ email, password, isJson: 1 }),
  }, options);
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403 || response.status === 400) return false;
  throw new ApiError(`Thirstt returned an error (${response.status}).`);
}
