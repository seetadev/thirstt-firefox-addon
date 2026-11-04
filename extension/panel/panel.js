import { API_BASE } from '../config.js';
import { sanitizeHtml } from '../lib/sanitize.js';

const $ = (id) => document.getElementById(id);
const views = ['loading', 'login', 'article', 'error'];
function show(name) { for (const v of views) $(v).hidden = v !== name; }

function showError(message) { $('error').textContent = message; show('error'); }

function close() {
  // The overlay host removes the iframe; it only trusts messages that come from this exact window.
  parent.postMessage({ type: 'thirstt-close' }, '*');
}

// All network access goes through the background page (shared, unpartitioned cookie jar; see background.js).
const ask = (message) => browser.runtime.sendMessage(message);

async function load() {
  show('loading');
  try {
    const result = await ask({ type: 'thirstt:extract' });   // the background learns the page URL itself
    if (result?.status === 'login-required') {
      show('login');
      $('email').focus();
      return;
    }
    if (result?.status !== 'ok') {
      showError(result?.message ?? 'Something went wrong.');
      return;
    }
    $('article-title').textContent = result.title;              // text, never HTML
    $('article-content').replaceChildren(sanitizeHtml(result.content));
    show('article');
  } catch {
    showError('Something went wrong.');
  }
}

$('register-link').href = `${API_BASE}/register`;
$('close').addEventListener('click', close);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('login-button');
  const error = $('login-error');
  error.hidden = true;
  button.disabled = true;
  try {
    const result = await ask({ type: 'thirstt:login', email: $('email').value, password: $('password').value });
    if (result?.status === 'error') {
      error.textContent = result.message;
      error.hidden = false;
    } else if (result?.ok) {
      $('password').value = '';
      await load();
    } else {
      error.textContent = 'Wrong e-mail or password.';
      error.hidden = false;
      $('password').select();
    }
  } catch {
    error.textContent = 'Something went wrong.';
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

load();
