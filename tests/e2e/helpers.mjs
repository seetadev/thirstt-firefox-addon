// Real-Firefox helpers: Selenium + geckodriver, add-on installed temporarily, test-double backend.
import { Builder, Browser } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMock } from '../fixtures/mock-server.mjs';

export const REPO = resolve(import.meta.dirname, '..', '..');
export const ADDON_ID = 'jid1-XahVBfTj5Fp3Sg@jetpack';
export const WIDGET = 'jid1-xahvbftj5fp3sg_jetpack-browser-action';
const GECKODRIVER = process.env.GECKODRIVER || (existsSync('/snap/bin/geckodriver') ? '/snap/bin/geckodriver' : 'geckodriver');

export async function startMock(port, opts) {
  const mock = createMock(opts);
  await new Promise((r) => mock.server.listen(port, '127.0.0.1', r));
  mock.base = `http://127.0.0.1:${port}`;
  mock.state_ = async () => (await fetch(`${mock.base}/__test__/state`)).json();
  mock.reset = () => fetch(`${mock.base}/__test__/reset`);
  mock.useFixture = (name) => fetch(`${mock.base}/__test__/fixture?name=${name}`);
  mock.stop = () => new Promise((r) => mock.server.close(r));
  return mock;
}

/** Builds the add-on against `apiBase` (test build) and returns the zip path. */
export function buildTestAddon(apiBase, name) {
  const out = `build/${name}`;
  execFileSync('node', ['tools/build.mjs', '--api-base', apiBase, '--out', out], { cwd: REPO, stdio: 'ignore' });
  execFileSync('npx', ['web-ext', 'build', '-s', out, '-a', `${out}-artifacts`, '--overwrite-dest'], { cwd: REPO, stdio: 'ignore' });
  return `${REPO}/${out}-artifacts/thirstt_test_build_-0.2.0.zip`;
}

export async function startFirefox(zip) {
  const options = new firefox.Options();
  if (!process.env.HEADFUL) options.addArguments('-headless');
  const service = new firefox.ServiceBuilder(GECKODRIVER).addArguments('--allow-system-access');
  const driver = await new Builder().forBrowser(Browser.FIREFOX).setFirefoxOptions(options).setFirefoxService(service).build();
  await driver.installAddon(zip, true);
  await driver.get('about:blank');
  await chrome(driver, `await new Promise(r => setTimeout(r, 800)); window.CustomizableUI.addWidgetToArea('${WIDGET}', 'nav-bar'); done(1);`);
  return driver;
}

/** Runs async code in Firefox's privileged (chrome) context; `done(value)` returns the result. */
export async function chrome(driver, body) {
  await driver.setContext(firefox.Context.CHROME);
  try {
    const result = await driver.executeAsyncScript(
      `const done = arguments[arguments.length - 1]; (async () => { try { ${body} } catch (e) { done({ __error: String(e) }); } })();`);
    if (result && result.__error) throw new Error(result.__error);
    return result;
  } finally {
    await driver.setContext(firefox.Context.CONTENT);
  }
}

export const clickToolbarButton = (driver) => chrome(driver,
  `document.getElementById('${WIDGET}').querySelector('toolbarbutton').click(); await new Promise(r => setTimeout(r, 2000)); done(1);`);

export const badgeText = (driver) => chrome(driver,
  `done(document.getElementById('${WIDGET}').querySelector('.toolbarbutton-badge')?.textContent ?? '');`);

/** URLs of the iframes of the selected tab (uuid replaced), i.e. the overlay. */
export const overlayFrames = (driver) => chrome(driver, `
  done(gBrowser.selectedBrowser.browsingContext.children.map(c =>
    (c.currentWindowGlobal?.documentURI?.spec ?? '').replace(/moz-extension:\\/\\/[^/]+/, 'moz-extension://<uuid>')));`);

export const extensionUuid = (driver) => chrome(driver,
  `done(WebExtensionPolicy.getByID('${ADDON_ID}').mozExtensionHostname);`);

export const addonInfo = (driver) => chrome(driver, `
  const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const a = await AddonManager.getAddonByID('${ADDON_ID}');
  const p = WebExtensionPolicy.getByID('${ADDON_ID}');
  done({ name: a.name, version: a.version, active: a.isActive, temporary: a.temporarilyInstalled, manifestVersion: p.manifestVersion,
         permissions: [...p.permissions].sort(), origins: p.allowedOrigins.patterns.map(x => x.pattern).filter(x => !x.startsWith('moz-extension:')) });`);
