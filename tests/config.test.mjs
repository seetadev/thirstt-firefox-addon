// Consistency of the manifest with config.js, plus the least-privilege and "nothing logs" guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { API_BASE } from '../extension/config.js';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('host_permissions is exactly the API origin in config.js (hostname pattern, no port)', () => {
  const u = new URL(API_BASE);
  assert.deepEqual(manifest.host_permissions, [`${u.protocol}//${u.hostname}/*`]);
  assert.equal(u.port, '', 'API_BASE must not carry a port: match patterns ignore it and a port makes the pattern never match');
  assert.equal(API_BASE, u.origin, 'API_BASE must be a bare origin');
});

test('least privilege: activeTab + scripting only, no <all_urls>, one web-accessible resource', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  assert.ok(!JSON.stringify(manifest).includes('"<all_urls>"') || manifest.web_accessible_resources.every((r) => r.resources.join() === 'panel/panel.html'));
  assert.deepEqual(manifest.host_permissions.filter((p) => p.includes('*://') || p === '<all_urls>'), []);
  assert.deepEqual(manifest.web_accessible_resources.flatMap((r) => r.resources), ['panel/panel.html']);
});

test('identity and floors', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'jid1-XahVBfTj5Fp3Sg@jetpack');
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.equal(manifest.browser_specific_settings.gecko_android.strict_min_version, '142.0');
});

test('data collection is declared and matches what the code sends (credentials, page URL)', () => {
  const required = manifest.browser_specific_settings.gecko.data_collection_permissions.required;
  assert.deepEqual([...required].sort(), ['authenticationInfo', 'browsingActivity', 'personallyIdentifyingInfo']);
});

test('strict CSP: no inline script, no eval, no plugins, no base tag', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('every file the manifest references exists', () => {
  const refs = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...manifest.background.scripts,
    ...manifest.web_accessible_resources.flatMap((r) => r.resources)];
  const present = new Set(files('extension').map((f) => f.replace(/^extension\//, '')));
  for (const r of refs) assert.ok(present.has(r), `${r} is referenced but missing`);
});

test('shipped code never logs, evals, alerts, or assigns HTML (credentials must not reach a console)', () => {
  const banned = [/\bconsole\s*\./, /\balert\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write/];
  for (const f of files('extension').filter((n) => /\.(js|html)$/.test(n))) {
    // Comments may mention these words; only code counts.
    const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const re of banned) assert.doesNotMatch(text, re, `${f} matches ${re}`);
  }
});

test('panel.html has no inline script or inline handlers', () => {
  const html = readFileSync('extension/panel/panel.html', 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test('the page URL never travels through a place a web page can control (query string / message field)', () => {
  const panel = readFileSync('extension/panel/panel.js', 'utf8');
  const overlay = readFileSync('extension/content/overlay.js', 'utf8');
  const background = readFileSync('extension/background.js', 'utf8');
  assert.doesNotMatch(panel, /location\.search|URLSearchParams/, 'the panel must not read a URL from its own query string (any web page can frame it)');
  assert.doesNotMatch(overlay, /panelUrl\}\?/, 'the overlay must not put the page URL into the iframe URL');
  assert.doesNotMatch(background, /message\??\.url/, 'the background must not use a URL supplied in a message');
  assert.match(background, /trustedPageUrl\(sender\)/, 'the background must learn the page URL from the overlay content script');
});
