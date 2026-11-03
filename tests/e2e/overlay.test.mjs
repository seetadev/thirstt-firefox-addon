// Real Firefox (geckodriver + Selenium), the add-on installed temporarily, a local TEST DOUBLE backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { By, until } from 'selenium-webdriver';
import { startMock, buildTestAddon, startFirefox, clickToolbarButton, badgeText, overlayFrames, extensionUuid, addonInfo, ADDON_ID } from './helpers.mjs';

const PORT = 8790;
let mock, driver;
const PAGE = () => `${mock.base}/pages/article.html`;

before(async () => {
  mock = await startMock(PORT);
  driver = await startFirefox(buildTestAddon(mock.base, 'e2e'));
});
after(async () => {
  await driver?.quit();
  await mock?.stop();
});

test('installs as a Manifest V3 add-on with least-privilege permissions', async () => {
  const info = await addonInfo(driver);
  assert.equal(info.name, 'Thirstt (test build)');
  assert.equal(info.manifestVersion, 3);
  assert.equal(info.active, true);
  assert.deepEqual(info.permissions, ['activeTab', 'scripting']);
  assert.deepEqual(info.origins, ['http://127.0.0.1/*']);      // only the configured API host, no <all_urls>
});

test('toolbar click opens an extension-origin overlay iframe, a second click closes it, a third reopens it', async () => {
  await mock.reset();
  await driver.get(`${PAGE()}#section-2`);
  await clickToolbarButton(driver);
  const frames = await overlayFrames(driver);
  assert.equal(frames.length, 1);
  assert.match(frames[0], /^moz-extension:\/\/<uuid>\/panel\/panel\.html\?u=/);
  await clickToolbarButton(driver);
  assert.deepEqual(await overlayFrames(driver), []);
  await clickToolbarButton(driver);
  assert.equal((await overlayFrames(driver)).length, 1);
  await clickToolbarButton(driver);
  assert.deepEqual(await overlayFrames(driver), []);
});

test('the page DOM is untouched apart from one closed-shadow host; backend sees the encoded URL without the #fragment', async () => {
  await mock.reset();
  await driver.get(`${PAGE()}#section-2`);
  const before = await driver.executeScript('return document.body.innerHTML');
  await clickToolbarButton(driver);
  assert.equal(await driver.executeScript('return document.body.innerHTML'), before);                 // body untouched
  assert.equal(await driver.executeScript('return document.documentElement.lastElementChild.shadowRoot'), null);   // closed shadow root
  assert.equal(await driver.findElement(By.id('page-field')).getAttribute('value'), 'page-secret-not-typed-by-the-add-on');
  const { extractRequests } = await mock.state_();
  assert.equal(extractRequests.length, 1);
  assert.equal(extractRequests[0].url, PAGE());                                   // no "#section-2"
  assert.equal(extractRequests[0].rawQuery, `?url=${encodeURIComponent(PAGE())}`); // properly encoded
  await clickToolbarButton(driver);                                                // close
});

test('on a non-http page the button reports it cannot run and no overlay appears', async () => {
  await driver.get('about:blank');
  await clickToolbarButton(driver);
  assert.equal(await badgeText(driver), '!');
  assert.deepEqual(await overlayFrames(driver), []);
});

test('panel: login required -> wrong password message -> login -> sanitised article', async () => {
  await mock.reset();
  const uuid = await extensionUuid(driver);
  await driver.get(`moz-extension://${uuid}/panel/panel.html?u=${encodeURIComponent(PAGE() + '#x')}`);
  await driver.wait(until.elementIsVisible(driver.findElement(By.id('login'))), 8000);
  assert.equal(await driver.findElement(By.id('register-link')).getAttribute('href'), `${mock.base}/register`);

  await driver.findElement(By.id('email')).sendKeys('wrong@example.invalid');
  await driver.findElement(By.id('password')).sendKeys('nope');
  await driver.findElement(By.id('login-button')).click();
  await driver.wait(until.elementIsVisible(driver.findElement(By.id('login-error'))), 8000);
  assert.equal(await driver.findElement(By.id('login-error')).getText(), 'Wrong e-mail or password.');

  await driver.findElement(By.id('email')).clear();
  await driver.findElement(By.id('password')).clear();
  await driver.findElement(By.id('email')).sendKeys(mock.FAKE_USER.email);
  await driver.findElement(By.id('password')).sendKeys(mock.FAKE_USER.password);
  await driver.findElement(By.id('login-button')).click();
  await driver.wait(until.elementIsVisible(driver.findElement(By.id('article'))), 8000);

  assert.equal(await driver.findElement(By.id('article-title')).getText(), 'Fixture article: a short, harmless extract');
  const html = await driver.findElement(By.id('article-content')).getAttribute('innerHTML');
  assert.match(html, /<blockquote>/);
  assert.match(html, /<li>first item<\/li>/);
  assert.match(html, /<a href="https:\/\/example\.com\/" target="_blank" rel="noopener noreferrer nofollow">safe link<\/a>/);
  const state = await mock.state_();
  assert.deepEqual(state.loginAttempts.map((a) => a.ok), [false, true]);
  assert.equal(state.extractRequests.at(-1).loggedIn, true);
  assert.equal(state.extractRequests.at(-1).url, PAGE());
});

test('a login carries over to the overlay on a web page (requests use the extension cookie jar, not a per-site partition)', async () => {
  // Test 5 logged in through the panel page. Opening the overlay on an ordinary web page must now find the session.
  await mock.reset();
  await driver.get(PAGE());
  await clickToolbarButton(driver);
  assert.equal((await overlayFrames(driver)).length, 1);
  const { extractRequests } = await mock.state_();
  assert.equal(extractRequests.length, 1);
  assert.equal(extractRequests[0].loggedIn, true, 'the overlay request did not carry the session cookie');
  await clickToolbarButton(driver);   // close
});
