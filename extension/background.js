// MV3 event page.
//  1. Toolbar click (activeTab): inject the overlay into the current http(s) page.
//  2. Network access for the overlay panel. All requests to the Thirstt API are made HERE, not from the
//     panel iframe: an extension frame embedded in a web page gets cookies partitioned per embedding site,
//     so a login made on one site would be lost on the next. The background uses the extension's own
//     cookie jar, so the Thirstt session is shared across sites.
import { API_BASE } from './config.js';
import { fetchExtract, login, ApiError } from './lib/api.js';

const CAN_RUN = new Set(['http:', 'https:']);
const PANEL_URL = browser.runtime.getURL('panel/panel.html');

async function flag(tabId, title) {
  await browser.action.setBadgeText({ tabId, text: '!' });
  await browser.action.setTitle({ tabId, title });
}

browser.action.onClicked.addListener(async (tab) => {
  let protocol = '';
  try { protocol = new URL(tab.url).protocol; } catch { /* no URL: not injectable */ }
  if (!CAN_RUN.has(protocol)) {
    await flag(tab.id, 'Thirstt only works on http:// and https:// pages');
    return;
  }
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] });
    await browser.action.setBadgeText({ tabId: tab.id, text: '' });
    await browser.action.setTitle({ tabId: tab.id, title: 'Thirstt' });
  } catch {
    await flag(tab.id, 'Thirstt cannot run on this page');
  }
});

function httpUrlWithoutFragment(value) {
  const url = new URL(String(value));
  if (!CAN_RUN.has(url.protocol)) throw new ApiError('Only http:// and https:// pages are supported.');
  url.hash = '';
  return url.href;
}

browser.runtime.onMessage.addListener((message, sender) => {
  // Only our own panel page may use the API through us.
  if (sender.id !== browser.runtime.id || !sender.url?.startsWith(PANEL_URL)) return undefined;
  return (async () => {
    try {
      if (message?.type === 'thirstt:extract') return await fetchExtract(API_BASE, httpUrlWithoutFragment(message.url));
      if (message?.type === 'thirstt:login') {
        return { status: 'login', ok: await login(API_BASE, String(message.email ?? ''), String(message.password ?? '')) };
      }
      return { status: 'error', message: 'Unknown request.' };
    } catch (error) {
      return { status: 'error', message: error instanceof ApiError ? error.message : 'Something went wrong.' };
    }
  })();
});
