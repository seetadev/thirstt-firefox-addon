// Copies extension/ to a temp directory with a different API base, for testing against a local server:
//   node tools/build.mjs --api-base http://127.0.0.1:8780 --out build/test
// Rewrites extension/config.js and the matching manifest "host_permissions" entry. The result is named
// "Thirstt (test build)" so it can never be mistaken for the real add-on.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'api-base': { type: 'string' }, out: { type: 'string', default: 'build/test' } } });
if (!values['api-base']) { console.error('usage: node tools/build.mjs --api-base <url> [--out dir]'); process.exit(2); }

const base = new URL(values['api-base']);
if (!['http:', 'https:'].includes(base.protocol)) { console.error('api base must be http(s)'); process.exit(2); }
const apiBase = base.origin;

const original = readFileSync('extension/config.js', 'utf8');
const oldBase = /export const API_BASE = '([^']+)';/.exec(original)?.[1];
if (!oldBase) { console.error('could not find API_BASE in extension/config.js'); process.exit(1); }

rmSync(values.out, { recursive: true, force: true });
mkdirSync(values.out, { recursive: true });
cpSync('extension', values.out, { recursive: true });
writeFileSync(`${values.out}/config.js`, original.replace(oldBase, apiBase));

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
// Match patterns have no port: "http://127.0.0.1/*" already matches every port on that host
// (a pattern that includes one is accepted but never matches, so requests fail CORS).
const pattern = (origin) => `${new URL(origin).protocol}//${new URL(origin).hostname}/*`;
manifest.host_permissions = manifest.host_permissions.map((p) => (p === pattern(oldBase) ? pattern(apiBase) : p));
manifest.name = 'Thirstt (test build)';
writeFileSync(`${values.out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`built ${values.out}: API_BASE ${oldBase} -> ${apiBase}`);
