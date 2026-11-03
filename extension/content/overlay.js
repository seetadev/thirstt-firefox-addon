// Injected on demand (toolbar click, activeTab). Idempotent: a second click toggles the overlay.
// The overlay is an iframe of an EXTENSION page inside a closed shadow root. The article and the login
// form live in that iframe, so page scripts can neither read what is typed nor receive backend HTML.
(() => {
  if (globalThis.__thirsttOverlay) {
    globalThis.__thirsttOverlay.toggle();
    return;
  }

  const panelUrl = browser.runtime.getURL('panel/panel.html');
  const panelOrigin = new URL(panelUrl).origin;
  let host = null;
  let frame = null;

  function close() {
    window.removeEventListener('message', onMessage, true);
    host?.remove();
    host = frame = null;
  }

  function onMessage(event) {
    // Only the panel's own window, from the extension origin, may close the overlay.
    if (frame && event.source === frame.contentWindow && event.origin === panelOrigin && event.data?.type === 'thirstt-close') {
      close();
    }
  }

  function open() {
    host = document.createElement('div');
    host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647;');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #fff;
               box-shadow: 3px 3px 5px #bdbdbd; opacity: 0; transition: opacity 0.2s ease; }
      iframe.on { opacity: 1; }
      @media (prefers-reduced-motion: reduce) { iframe { transition: none; } }`;
    frame = document.createElement('iframe');
    frame.title = 'Thirstt';
    const url = new URL(location.href);
    url.hash = '';
    frame.src = `${panelUrl}?u=${encodeURIComponent(url.href)}`;
    frame.addEventListener('load', () => { frame?.classList.add('on'); frame?.focus(); });
    shadow.append(style, frame);
    document.documentElement.append(host);
    window.addEventListener('message', onMessage, true);
  }

  globalThis.__thirsttOverlay = { toggle: () => (host ? close() : open()) };
  globalThis.__thirsttOverlay.toggle();
})();
