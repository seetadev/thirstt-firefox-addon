// Turns untrusted backend HTML into a DocumentFragment that contains only an allow-list of harmless
// elements. Nothing is ever assigned with innerHTML: the markup is parsed inertly with DOMParser (scripts
// and event handlers never run) and a NEW tree is built from allowed tags only, copying no attributes
// except a vetted <a href>.

const ALLOWED = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'EM', 'I', 'STRONG', 'B', 'CODE', 'PRE', 'A', 'HR',
]);
// Elements whose *contents* must not survive either (not just the tag).
const DROP_WITH_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA',
  'AUDIO', 'VIDEO', 'CANVAS', 'IMG', 'PICTURE', 'SOURCE',
]);
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:']);

export function safeHref(value) {
  try {
    const url = new URL(String(value).trim());
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeHtml(html, doc = document) {
  const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  const out = doc.createDocumentFragment();
  copyChildren(parsed.body, out, doc);
  return out;
}

function copyChildren(from, into, doc) {
  for (const node of from.childNodes) {
    if (node.nodeType === 3) {                       // text
      into.append(doc.createTextNode(node.nodeValue));
      continue;
    }
    if (node.nodeType !== 1) continue;               // comments, processing instructions: dropped
    const tag = node.tagName.toUpperCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED.has(tag)) {                         // unknown wrapper (div, span, ...): keep its text/children
      copyChildren(node, into, doc);
      continue;
    }
    const el = doc.createElement(tag.toLowerCase());
    if (tag === 'A') {
      const href = safeHref(node.getAttribute('href') ?? '');
      if (href) {
        el.setAttribute('href', href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    copyChildren(node, el, doc);
    into.append(el);
  }
}
