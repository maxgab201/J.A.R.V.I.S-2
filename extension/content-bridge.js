/* ============================================================
   content-bridge.js — puente entre la web J.A.R.V.I.S. y el
   service worker de la extensión.
   ────────────────────────────────────────────────────────────
   Inyectado en https://*.vercel.app/* y localhost.
   - Escucha window.postMessage({ source:'jarvis-web', ... })
   - Reenvía al service worker via chrome.runtime.sendMessage
   - Devuelve resultado a la web via window.postMessage({ source:'jarvis-ext' })
   - Anuncia su presencia con un evento 'jarvis-ext-ready'.
   ============================================================ */
(function () {
  'use strict';
  if (window.__JARVIS_EXT_BRIDGE__) return;
  window.__JARVIS_EXT_BRIDGE__ = true;

  const VERSION = '1.0.0';
  let manifestVersion = VERSION;
  try { manifestVersion = chrome.runtime.getManifest().version; } catch {}

  function announce() {
    try {
      window.postMessage({
        source: 'jarvis-ext',
        type: 'ready',
        payload: { version: manifestVersion, browser: 'chromium' },
      }, '*');
      document.dispatchEvent(new CustomEvent('jarvis-ext-ready', {
        detail: { version: manifestVersion, browser: 'chromium' },
      }));
    } catch (e) { /* ignore */ }
  }

  // anunciar inmediatamente y al cargar el DOM
  announce();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  }
  // re-anunciar cada 5s durante 30s por si la web carga lento
  let n = 0;
  const tick = setInterval(() => { announce(); if (++n > 6) clearInterval(tick); }, 5000);

  // ---- recibir órdenes de la web ----
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.source !== window) return;
    const m = ev.data;
    if (m.source !== 'jarvis-web' || !m.id || !m.type) return;

    chrome.runtime.sendMessage({ type: m.type, payload: m.payload || {} }, (resp) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ source: 'jarvis-ext', id: m.id, ok: false, error: chrome.runtime.lastError.message }, '*');
        return;
      }
      if (m.type === 'ping' && resp?.ok) {
        // respuesta de ping: devolver formato 'data' con info
        window.postMessage({ source: 'jarvis-ext', id: m.id, ok: true, data: resp.data || { version: manifestVersion } }, '*');
        return;
      }
      window.postMessage({ source: 'jarvis-ext', id: m.id, ok: !!resp?.ok, data: resp?.data, error: resp?.error }, '*');
    });
  });

  // ---- eventos del service worker → web ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'ext-event') return;
    try {
      window.postMessage({ source: 'jarvis-ext', type: 'event', event: msg.event, data: msg.data }, '*');
    } catch {}
  });

  console.log('[J.A.R.V.I.S. ext bridge] inyectado v' + manifestVersion);
})();
