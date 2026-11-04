# Helia integration points (plan and scaffold)

Status: **planning + scaffold only.** `extension/lib/helia.js` is a tested client; nothing in the add-on imports it (a test enforces that, and that the manifest and permissions are unchanged). It is **excluded from the built zip** (`--ignore-files lib/helia.js` in the `build` script; a test builds the zip and checks it is absent) so no unused code ships; when it is wired in, remove that flag and flip the test.

The add-on never embeds Helia, **and it never talks to the Helia sidecar at all.** It talks to the Thirstt backend, which talks to the sidecar. This is the main design point of this document.

## The sidecar contract (read from the source at commit `8afe218`, confirmed by running it, and re-verified at `a114973`)

| Call | Behaviour |
|---|---|
| `POST /upload` (raw bytes) | `200 {"cid": "..."}`. Over the limit (`MESHKIT_HELIA_MAX_UPLOAD_MB`, default **20**) -> `413`. |
| `GET /retrieve/<cid>` | `200` raw bytes. Malformed CID -> `400`. A CID it does not hold -> **`504` after 5 s**, **not 404**, in the default `HELIA_NETWORK=offline` mode. |
| `GET /list` | every CID uploaded since the sidecar started (global, not per user). |
| `GET /health` | `200 {"status":"ok",...}`, unauthenticated. |
| auth | one shared secret for everybody: `X-Meshkit-Helia-Token`, required on every route except `/health` (otherwise `401`). The sidecar publishes no host port. |

Verified against the real sidecar: a small payload gets the raw-leaf `CIDv1` equal to `sha2-256` computed locally; unknown CID -> 504 after 5.0 s; 413 over the limit; 400 for malformed CIDs; 401 without the token. Not in the sidecar: **delete**, per-user ownership, replication (offline mode).

**Sidecar bug found while testing, now fixed (commit `8afe218` had it):** `POST /upload` **without a `Content-Type` header** was answered `200` with the CID of an *empty* file and **nothing was stored** (and the size limit was skipped). Fixed in [Tornado-Backend-Stack#15](https://github.com/seetadev/Tornado-Backend-Stack/pull/15) (`a114973`): a missing `Content-Type` is treated as `application/octet-stream` and an empty body is a `400`. The clients here always send `Content-Type: application/octet-stream` anyway, so they work against both. The integration test for it is `xfail` (`todo` in the add-on): it fails against an old sidecar without failing the run, and reports `XPASS` / passes against `a114973` (verified).

**Dependency:** the sidecar exists only in the open PR [seetadev/Tornado-Backend-Stack#15](https://github.com/seetadev/Tornado-Backend-Stack/pull/15) (private repository).

## Why the add-on cannot hold the sidecar secret, and how auth works instead

An extension is a zip that every user can unpack, so **anything shipped in it, or fetched into it and kept, is public**. The sidecar has a single secret and no per-user credentials, so a secret in the add-on would give every user (and anyone who reads the zip) unlimited read/write/enumerate access to all stored data.

Proposed flow:

```
add-on background page --HTTPS + Thirstt session cookie--> Thirstt backend --X-Meshkit-Helia-Token, private network--> sidecar
      (no secret)             (already how login works)      authorises the user,                                     (internal only)
                                                              checks ownership/quota, holds the secret
```

- The add-on already logs in to Thirstt and keeps the session cookie in the background page's cookie jar (that is why every API call is made there, not in the panel). The Helia calls reuse exactly that session: `credentials: 'include'`, HTTPS only, from the background page.
- The backend needs new endpoints (they do not exist; the client's defaults are a proposal): `POST /helia/upload`, `GET /helia/retrieve/<cid>`, `GET /helia/health`. Each requires a logged-in user.
- The backend, not the add-on, enforces what the sidecar cannot: **per-user ownership** (a table `user -> cid, kind, size, created`; retrieve only your own CIDs, because CIDs are not secrets), **quotas and rate limits**, a **lower size cap** than the sidecar's 20 MB (saved articles are text), CID validation, and the 502/504 mapping.
- Tornado-Backend-Stack's existing `/meshkit-helia/*` proxy is **not usable for this as it is**: it has no caller authentication (only a CORS allowlist, which is not authentication), no ownership, and an open `/list` that returns every CID. It could be hardened with the existing secure-cookie login (`@tornado.web.authenticated` plus the ownership table), or the Thirstt backend gets its own routes.
- No new extension permission is needed: the background page already has the host permission for the API origin, and extension background fetches are not subject to CORS.

## What the scaffold provides

`extension/lib/helia.js`: `createHeliaClient({ baseUrl, prefix = '/helia', ... })` returning `put(Uint8Array) -> cid`, `get(cid) -> Uint8Array`, `health() -> boolean`, built on `fetch` (so it belongs in the background page).

- **There is nowhere to put a secret**: any option named like a secret/token/key/password makes the constructor throw, and a test checks the file contains no sidecar header name or `Authorization`. In the end-to-end test the secret lives only in the stand-in backend and the test asserts it never appears in any request the add-on made, any response header or body, or any file under `extension/`.
- HTTPS only for the base URL (plain http only for loopback, as in `lib/api.js`); prefix must be plain path segments.
- Checked **locally before any request**: CID shape, payload size (default 5 MiB), non-empty bytes.
- `credentials: 'include'`, `cache: 'no-store'`, `referrerPolicy: 'no-referrer'`, **`redirect: 'error'`** (a redirect must never carry the session cookie), 8 s timeout, a reply that ended on another origin is discarded, downloads are counted and refused above the limit (default 5 MiB), the upload reply is validated.
- Errors, mapped like the sidecar/Tornado proxy so callers fall back uniformly: unreachable / 502 / 503 -> `HeliaUnavailable` (502); slow or 504 -> `HeliaTimeout` (504); 401/403 -> `HeliaLoginRequired` (401, "log in to Thirstt first"); `HeliaInvalidCid` (400); `HeliaPayloadTooLarge` (413); `HeliaNotFound` (404); else `HeliaError`.

## Configuration

The base URL is `API_BASE` in `extension/config.js` (the one place the backend is named); the `/helia` prefix is the only new setting. There is **no secret setting** in the add-on. The sidecar URL and `MESHKIT_HELIA_SHARED_SECRET` belong to the Thirstt backend's configuration.

## Integration points

1. **Saved articles by CID.** After the overlay shows an extract, a "Save" action in the panel sends a message to the background page, which seals the sanitised article (JSON: url, title, content, saved-at) and `put()`s it; the CID is recorded in the user's account by the backend. Reading it back is `get(cid)` through the same path. This is the first thing to build.
2. **Clips (Clip Text / Clip Para).** The old add-on had these two buttons but they only logged to the console and had no endpoint; they are **not ported** and need a product definition. If they are built, clips are small blobs that fit this model exactly (store a clip, list my clips, open one).
3. **Share by CID (optional).** A saved item could be shared by link; with client-side encryption the key travels in the URL fragment (never sent to a server).
4. **Offline reading (optional).** Caching fetched items locally would need the `storage` permission, which the add-on does not have today; adding a permission changes the store listing, so it is a deliberate decision.

When any of these is wired, the background page owns the client; the panel and the overlay only exchange messages (as they do today for `thirstt:extract` and `thirstt:login`), with the same sender checks.

## Data-collection disclosure

`manifest.json` declares `authenticationInfo`, `browsingActivity` and `personallyIdentifyingInfo` as required data collection. Uploading **saved page content or clips** to the Thirstt backend is a further category (very likely `websiteContent`; check Mozilla's current list for `data_collection_permissions`). The manifest declaration, the README and the store listing must be updated in the same change that wires this in, and the `strict_min_version` floor is already 140 so the declaration is supported.

## Fallback on 502 / 504

Saving is never required for the add-on's core feature (reading the extract), so a Helia failure must never block it:

- `HeliaUnavailable` (502) or `HeliaTimeout` (504) on save -> show "Couldn't save, try again", keep the article on screen, do not retry in a loop. There is no local queue (see offline reading above). A `504` can also mean "the sidecar does not hold that CID" (offline mode), so on read it is "not available right now".
- `HeliaLoginRequired` -> show the existing login form, then retry once.
- `HeliaInvalidCid` / `HeliaNotFound` on read -> remove the dead entry from the user's list.
- Never log content, CIDs of private items, or cookies; the add-on has no logging at all, and a test enforces that.

## Is encryption needed?

**Yes, for anything user-specific.** Saved articles and clips reveal what a person reads; the sidecar stores plaintext, anyone with a CID can read it from the sidecar's perspective, `/list` shows every CID, backend and storage operators would see all content, and in `online` mode queried CIDs are visible to peers and gateways. Seal the bytes in the background page before `put()` and open them after `get()` (WebCrypto AES-256-GCM, a fresh random nonce per item, with the item kind and format version authenticated as additional data). Consequences: identical items no longer share a CID (no de-duplication); CIDs and sizes still leak metadata; and because the sidecar has **no delete**, "forget this item" can only be done by **destroying the key** (crypto-shredding), which also makes lost keys unrecoverable. Where the key lives is the real decision (open question 3). The scaffold does not implement encryption.

## Open questions

1. Will the Thirstt backend add the authenticated `/helia/*` endpoints (with ownership, quota, rate limiting, and a lower size cap), or should Tornado-Backend-Stack's `/meshkit-helia/*` proxy be hardened and used? Either way `/list` must not be reachable by users.
2. Which features first: saved articles, clips (needs a definition), sharing?
3. Key custody for encryption: a random key kept in extension storage (new permission, lost with the profile), derived from a passphrase (user burden), or wrapped by the Thirstt account (the server could then read everything, so not end-to-end)?
4. Deletion and privacy: users will expect to delete saved items and an account; the sidecar cannot. Is crypto-shredding acceptable?
5. Data-collection declaration and the store listing text for the new data category.
6. Offline mode only (one node, one volume, no replication) or online Helia?

## Running the opt-in integration test (real sidecar)

The test puts a **stand-in for the Thirstt backend** (`tests/integration/thirstt-backend-double.mjs`: checks the mock session cookie, holds the secret, forwards) in front of the **real** sidecar, and drives the add-on client against it.

```bash
git clone git@github.com:seetadev/Tornado-Backend-Stack.git ../Tornado-Backend-Stack
git -C ../Tornado-Backend-Stack checkout a114973
export HELIA_SIDECAR_BUILD_CONTEXT=$PWD/../Tornado-Backend-Stack/meshkit-sidecar-helia
export HELIA_SIDECAR_SECRET=$(openssl rand -hex 32)
docker compose -f tests/integration/docker-compose.helia.yml up -d --build --wait
HELIA_SIDECAR_URL=http://127.0.0.1:5052 npm run test:integration
docker compose -f tests/integration/docker-compose.helia.yml down -v
```

Without `HELIA_SIDECAR_URL` those tests are skipped. The regular unit tests (`npm run test:unit`) use `tests/fixtures/helia-backend-double.mjs`, a **mock** of the proposed backend endpoints, not the real sidecar and not real Thirstt.
