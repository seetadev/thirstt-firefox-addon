// Security behaviour in real Firefox (add-on installed temporarily, TEST DOUBLE backend).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { By, until } from 'selenium-webdriver';
import { startMock, buildTestAddon, startFirefox, clickToolbarButton, extensionUuid, inOverlay } from './helpers.mjs';

const PORT = 8791;
const VECTORS = JSON.parse(readFileSync(new URL('../fixtures/xss-vectors.json', import.meta.url), 'utf8'));
let mock, driver;
const PAGE = () => `${mock.base}/pages/article.html`;

before(async () => {
  mock = await startMock(PORT);
  driver = await startFirefox(buildTestAddon(mock.base, 'e2e-security'));
  // log in once through the real overlay so the add-on holds a session
  await driver.get(PAGE());
  await clickToolbarButton(driver);
  await inOverlay(driver, async () => {
    await driver.wait(until.elementIsVisible(driver.findElement(By.id('login'))), 8000);
    await driver.findElement(By.id('email')).sendKeys(mock.FAKE_USER.email);
    await driver.findElement(By.id('password')).sendKeys(mock.FAKE_USER.password);
    await driver.findElement(By.id('login-button')).click();
    await driver.wait(until.elementIsVisible(driver.findElement(By.id('article'))), 8000);
  });
  await clickToolbarButton(driver);   // close
});
after(async () => {
  await driver?.quit();
  await mock?.stop();
});

test(`hostile extract (${VECTORS.length} injection vectors): nothing executes, nothing dangerous reaches the DOM`, async () => {
  await mock.useFixture('extract-xss.json');
  await driver.get(PAGE());
  await clickToolbarButton(driver);
  const report = await inOverlay(driver, async () => {
    await driver.wait(until.elementIsVisible(driver.findElement(By.id('article'))), 8000);
    await driver.sleep(1500);    // give any handler (onerror, onload, srcdoc...) time to fire
    return driver.executeScript(`
      const root = document.getElementById('article-content');
      const bad = root.querySelectorAll('script, style, iframe, frame, object, embed, svg, math, form, input, button, img, link, meta, base, template, noscript, video, audio, details');
      const attrs = [...root.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => e.localName + '[' + a.name + ']'));
      return {
        pwnedInPanel: window.__pwned ?? null,
        dangerousElements: [...bad].map((e) => e.localName),
        attributes: [...new Set(attrs)].sort(),
        hrefs: [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((h) => h !== null),   // href-less <a> is inert text
        title: document.getElementById('article-title').textContent,
        titleChildElements: document.getElementById('article-title').children.length,
        text: root.textContent,
        titleEl: document.getElementById('article-title').localName,
      };`);
  });
  assert.equal(report.pwnedInPanel, null, `a payload executed in the panel: ${report.pwnedInPanel}`);
  assert.deepEqual(report.dangerousElements, []);
  assert.deepEqual(report.attributes, ['a[href]', 'a[rel]', 'a[target]']);          // nothing but the vetted link attributes
  assert.deepEqual(report.hrefs, ['https://example.com/ok']);                         // only the legitimate link survives
  assert.equal(report.titleChildElements, 0);                                         // the title is text, not markup
  assert.match(report.title, /^<img src=x onerror=.*>Hostile <b>title<\/b>$/);
  assert.match(report.text, /START/);
  assert.match(report.text, /END/);
  assert.equal(await driver.executeScript('return window.__pwned ?? null'), null, 'a payload executed in the host PAGE');
  assert.equal(await driver.executeScript('return document.body.children.length'), 3);      // fixture page untouched (h1, p, input)
  await clickToolbarButton(driver);   // close
});

test('a hostile web page that frames the panel cannot make the add-on fetch anything', async () => {
  await mock.useFixture('extract-ok.json');
  await mock.reset();
  const uuid = await extensionUuid(driver);
  await driver.get(`${mock.base}/pages/frame-attacker.html?uuid=${uuid}&u=${encodeURIComponent('http://victim.invalid/private')}`);
  await driver.sleep(3000);     // plenty of time for the panel to ask the background for the extract
  // The point of the test: nothing was fetched for the attacker (and never for the URL it chose).
  const { extractRequests } = await mock.state_();
  assert.deepEqual(extractRequests, [], `the add-on made a request on behalf of a web page: ${JSON.stringify(extractRequests.map((r) => r.url))}`);
  const frame = await driver.findElement(By.id('victim-panel'));
  await driver.switchTo().frame(frame);
  try {
    await driver.wait(until.elementIsVisible(driver.findElement(By.id('error'))), 8000);
    assert.equal(await driver.findElement(By.id('error')).getText(), 'Thirstt can only be used from its toolbar button.');
    assert.equal(await driver.findElement(By.id('article')).isDisplayed(), false);
  } finally {
    await driver.switchTo().defaultContent();
  }
});

test('the same hostile frame cannot use the add-on to log in either', async () => {
  await mock.reset();
  const uuid = await extensionUuid(driver);
  await driver.get(`${mock.base}/pages/frame-attacker.html?uuid=${uuid}`);
  const frame = await driver.findElement(By.id('victim-panel'));
  await driver.switchTo().frame(frame);
  try {
    // the panel shows the refusal; also try to drive a login message directly from the panel's own context
    await driver.wait(until.elementIsVisible(driver.findElement(By.id('error'))), 8000);
    const reply = await driver.executeAsyncScript(`
      const done = arguments[arguments.length - 1];
      browser.runtime.sendMessage({ type: 'thirstt:login', email: '${mock.FAKE_USER.email}', password: '${mock.FAKE_USER.password}' }).then(done, (e) => done({ threw: String(e) }));`);
    assert.equal(reply.status, 'error');
  } finally {
    await driver.switchTo().defaultContent();
  }
  assert.deepEqual((await mock.state_()).loginAttempts, [], 'a login was attempted for a web page');
});
