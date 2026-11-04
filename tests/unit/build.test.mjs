// The built zip (what would be uploaded/signed), not the source tree. helia.js is scaffold: it stays in the repo and
// is unit-tested, but must not ship until something imports it. When wiring it in, remove "--ignore-files" from the
// "build" script in package.json and flip the first test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let zip, entries;
const read = (name) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });

before(() => {
  // Run the real "build" script from package.json (so its flags are what is tested), with only the output directory swapped.
  const out = mkdtempSync(join(tmpdir(), 'thirstt-build-'));
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts.build;
  assert.match(script, / -a web-ext-artifacts /, 'the build script changed shape; update this test');
  execSync(`npx ${script.replace(' -a web-ext-artifacts ', ` -a ${out} `)}`, { stdio: 'pipe' });
  zip = join(out, readdirSync(out).find((f) => f.endsWith('.zip')));
  entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter((e) => e && !e.endsWith('/'));
});

test('the built zip does not contain the unused Helia scaffold', () => {
  assert.ok(!entries.some((e) => /helia/i.test(e)), `helia is in the zip: ${entries.filter((e) => /helia/i.test(e))}`);
});

test('the built zip still has everything the extension needs', () => {
  for (const f of ['manifest.json', 'background.js', 'config.js', 'content/overlay.js', 'lib/api.js', 'lib/sanitize.js',
    'panel/panel.html', 'panel/panel.js', 'panel/panel.css', 'icons/logo-16.png', 'icons/logo-115.png']) {
    assert.ok(entries.includes(f), `${f} is missing from the zip`);
  }
});

test('nothing in the zip references the excluded file (it would be a broken import)', () => {
  for (const e of entries.filter((n) => /\.(js|html|json)$/.test(n))) assert.doesNotMatch(read(e), /helia/i, e);
});

test('only extension files are packaged (no tests, tooling or node_modules)', () => {
  assert.ok(!entries.some((e) => /(^|\/)(node_modules|tests|tools|package(-lock)?\.json|\.github)(\/|$)/.test(e)), entries.join(', '));
});
