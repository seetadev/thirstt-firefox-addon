// Thin client for the Thirstt backend. Nothing here logs; credentials and responses are never written
// to the console.

export class ApiError extends Error {}

export function extractUrl(apiBase, pageUrl) {
  return `${apiBase}/mediaservice/fetchExtract?url=${encodeURIComponent(pageUrl)}`;
}

async function request(url, init, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    return await fetchImpl(url, {
      credentials: 'include',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs),
      ...init,
    });
  } catch (error) {
    throw new ApiError(error?.name === 'TimeoutError' ? 'The request timed out.' : 'Could not reach Thirstt.');
  }
}

/**
 * Resolves to { status: 'ok', title, content } or { status: 'login-required' }.
 * Like the original add-on, a reply that is not the expected JSON (typically a login page) means
 * "log in first"; 401/403 do too. Any other failure throws ApiError.
 */
export async function fetchExtract(apiBase, pageUrl, options) {
  const response = await request(extractUrl(apiBase, pageUrl), { method: 'GET' }, options);
  if (response.status === 401 || response.status === 403) return { status: 'login-required' };
  if (!response.ok) throw new ApiError(`Thirstt returned an error (${response.status}).`);
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    return { status: 'login-required' };
  }
  const first = Array.isArray(data) ? data[0] : null;
  if (!first || typeof first !== 'object') return { status: 'login-required' };
  return {
    status: 'ok',
    title: typeof first.title === 'string' ? first.title : '',
    content: typeof first.content === 'string' && first.content ? first.content : 'No content available for this webpage',
  };
}

/** Resolves to true on success, false for a wrong e-mail/password; throws ApiError if unreachable. */
export async function login(apiBase, email, password, options) {
  const response = await request(`${apiBase}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ email, password, isJson: 1 }),
  }, options);
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403 || response.status === 400) return false;
  throw new ApiError(`Thirstt returned an error (${response.status}).`);
}
