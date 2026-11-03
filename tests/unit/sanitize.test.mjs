// Unit tests for the HTML sanitiser (jsdom provides DOMParser/document). The same sanitiser is exercised in
// real Firefox by the e2e suite; these are the fast, exhaustive-ish cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = window.DOMParser;
globalThis.document = window.document;
const { sanitizeHtml, safeHref } = await import('../../extension/lib/sanitize.js');

const render = (html) => {
  const box = window.document.createElement('div');
  box.append(sanitizeHtml(html, window.document));
  return box.innerHTML;
};

test('keeps ordinary article markup', () => {
  assert.equal(render('<h2>Hi</h2><p>One <em>two</em> <strong>three</strong></p><ul><li>a</li></ul>'),
    '<h2>Hi</h2><p>One <em>two</em> <strong>three</strong></p><ul><li>a</li></ul>');
});

test('drops script/style/iframe/form elements together with their content', () => {
  const out = render('<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://x.invalid"></iframe><form><input name=x></form><p>b</p>');
  assert.equal(out, '<p>a</p><p>b</p>');
});

test('never copies attributes except a vetted link href (no onerror/onclick/style/class)', () => {
  const out = render('<p onclick="x()" style="color:red" class="c" id="i">t</p><img src=x onerror="x()">');
  assert.equal(out, '<p>t</p>');
});

test('links: http(s) kept with rel/target; javascript:, data:, vbscript: and relative hrefs are removed', () => {
  assert.equal(render('<a href="https://example.invalid/a?b=1">x</a>'),
    '<a href="https://example.invalid/a?b=1" target="_blank" rel="noopener noreferrer nofollow">x</a>');
  for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', '/relative', '//evil.invalid']) {
    assert.equal(render(`<a href="${bad}">x</a>`), '<a>x</a>', bad);
  }
});

test('unknown wrappers are unwrapped, their text survives', () => {
  assert.equal(render('<div><span>hello <b>world</b></span></div>'), 'hello <b>world</b>');
});

test('comments, null and non-strings are handled', () => {
  assert.equal(render('<!-- c --><p>ok</p>'), '<p>ok</p>');
  assert.equal(render(null), '');
  assert.equal(render(undefined), '');
});

test('text is inert: markup-looking text is not re-parsed into elements', () => {
  assert.equal(render('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('safeHref rejects garbage', () => {
  assert.equal(safeHref('not a url'), null);
  assert.equal(safeHref(''), null);
  assert.equal(safeHref('https://example.invalid/'), 'https://example.invalid/');
});
