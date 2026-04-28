/* ============================================================
   J.A.R.V.I.S. Tab Controller — background service worker (MV3)
   ────────────────────────────────────────────────────────────
   Recibe órdenes desde el content-bridge inyectado en la web de
   J.A.R.V.I.S. (vía chrome.runtime.sendMessage) y opera sobre las
   pestañas del navegador.
   ============================================================ */

const VERSION = '1.0.0';

/* ---------- Helpers ---------- */
function safeTab(t) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    favIconUrl: t.favIconUrl || '',
    active: !!t.active,
    pinned: !!t.pinned,
    audible: !!t.audible,
    mutedInfo: t.mutedInfo || null,
    windowId: t.windowId,
    index: t.index,
    status: t.status || '',
  };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(safeTab);
}

async function activateTab(tabId) {
  const t = await chrome.tabs.update(tabId, { active: true });
  if (t && t.windowId != null) {
    try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
  }
  return safeTab(t);
}

async function closeTab(tabId) {
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

async function openTab({ url, active = true }) {
  if (!url || typeof url !== 'string') throw new Error('url requerido');
  if (!/^https?:\/\//i.test(url)) throw new Error('Solo http(s) permitido');
  const t = await chrome.tabs.create({ url, active });
  return safeTab(t);
}

/* ---------- Lectura de contenido vía scripting.executeScript ---------- */
async function readTab({ tabId, mode = 'summary', maxChars = 8000 }) {
  if (!tabId) throw new Error('tabId requerido');
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [mode, maxChars],
    func: (mode, maxChars) => {
      const out = {
        title: document.title,
        url: location.href,
        host: location.host,
      };
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      if (mode === 'full') {
        out.text = clean(document.body?.innerText || '').slice(0, maxChars);
      } else if (mode === 'main') {
        const main = document.querySelector('main, article, #main, [role="main"]');
        out.text = clean((main || document.body)?.innerText || '').slice(0, maxChars);
      } else if (mode === 'meta') {
        const metas = {};
        document.querySelectorAll('meta[name],meta[property]').forEach(m => {
          const k = m.getAttribute('name') || m.getAttribute('property');
          if (k) metas[k] = m.getAttribute('content') || '';
        });
        out.meta = metas;
        out.h1 = Array.from(document.querySelectorAll('h1')).slice(0,3).map(e => clean(e.innerText));
      } else { // summary
        const desc = document.querySelector('meta[name="description"], meta[property="og:description"]')?.content || '';
        const h1 = Array.from(document.querySelectorAll('h1')).slice(0,2).map(e => clean(e.innerText));
        const h2 = Array.from(document.querySelectorAll('h2')).slice(0,4).map(e => clean(e.innerText));
        const text = clean(document.body?.innerText || '').slice(0, Math.min(maxChars, 2500));
        out.description = clean(desc);
        out.h1 = h1; out.h2 = h2;
        out.preview = text;
        // detectar player de video
        const v = document.querySelector('video');
        if (v) {
          out.video = {
            paused: v.paused, muted: v.muted, currentTime: v.currentTime,
            duration: isFinite(v.duration) ? v.duration : null, volume: v.volume,
          };
        }
      }
      return out;
    },
  });
  return result || {};
}

/* ---------- Control: play/pause/scroll/click/type/key ---------- */
async function controlTab({ tabId, action, args = {} }) {
  if (!tabId) throw new Error('tabId requerido');
  if (!action) throw new Error('action requerida');

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [action, args],
    func: (action, args) => {
      const findVideo = () => document.querySelector('video');
      const findAudio = () => document.querySelector('audio');
      const focusEl = (sel) => {
        const el = sel ? document.querySelector(sel) : document.activeElement;
        if (!el) return null;
        try { el.focus(); } catch {}
        return el;
      };

      switch (action) {
        case 'play': {
          const v = findVideo() || findAudio();
          if (v) { v.play(); return { ok: true, what: 'video/audio play' }; }
          // YouTube
          const ytBtn = document.querySelector('.ytp-play-button');
          if (ytBtn && ytBtn.getAttribute('aria-label')?.toLowerCase().includes('reproducir')) { ytBtn.click(); return { ok: true, what: 'yt-play' }; }
          return { ok: false, what: 'no media element' };
        }
        case 'pause': {
          const v = findVideo() || findAudio();
          if (v) { v.pause(); return { ok: true, what: 'video/audio pause' }; }
          const ytBtn = document.querySelector('.ytp-play-button');
          if (ytBtn) { ytBtn.click(); return { ok: true, what: 'yt-pause' }; }
          return { ok: false, what: 'no media element' };
        }
        case 'toggle': {
          const v = findVideo() || findAudio();
          if (v) { v.paused ? v.play() : v.pause(); return { ok: true, what: 'media toggle', paused: v.paused }; }
          return { ok: false };
        }
        case 'mute': {
          const v = findVideo() || findAudio();
          if (v) { v.muted = !v.muted; return { ok: true, muted: v.muted }; }
          return { ok: false };
        }
        case 'volume': {
          const v = findVideo() || findAudio();
          if (!v) return { ok: false };
          const lvl = Math.max(0, Math.min(1, Number(args.level)));
          if (!isNaN(lvl)) v.volume = lvl;
          return { ok: true, volume: v.volume };
        }
        case 'seek': {
          const v = findVideo() || findAudio();
          if (!v) return { ok: false };
          if (typeof args.to === 'number') v.currentTime = Math.max(0, args.to);
          else if (typeof args.delta === 'number') v.currentTime = Math.max(0, v.currentTime + args.delta);
          return { ok: true, currentTime: v.currentTime };
        }
        case 'scrollTop':    window.scrollTo({ top: 0, behavior: 'smooth' }); return { ok: true };
        case 'scrollBottom': window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return { ok: true };
        case 'scrollBy':     window.scrollBy({ top: Number(args.y) || 0, left: Number(args.x) || 0, behavior: 'smooth' }); return { ok: true };
        case 'click': {
          const el = document.querySelector(args.selector || '');
          if (!el) return { ok: false, what: 'selector no encontrado' };
          el.click();
          return { ok: true };
        }
        case 'type': {
          const el = focusEl(args.selector);
          if (!el) return { ok: false };
          const text = String(args.text || '');
          if ('value' in el) {
            el.value = (args.append ? el.value : '') + text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.textContent = text;
          }
          return { ok: true };
        }
        case 'sendKey': {
          const key = String(args.key || 'Enter');
          const el = document.activeElement || document.body;
          ['keydown','keypress','keyup'].forEach(type => {
            el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }));
          });
          return { ok: true, key };
        }
        case 'getTitle': return { ok: true, title: document.title };
        case 'getUrl':   return { ok: true, url: location.href };
        case 'query': {
          const el = document.querySelector(args.selector || '');
          if (!el) return { ok: false };
          return { ok: true, text: (el.innerText || '').slice(0, 2000), html: (el.innerHTML || '').slice(0, 4000) };
        }
        default:
          return { ok: false, error: 'acción no soportada: ' + action };
      }
    },
  });
  return result || { ok: false };
}

async function reloadTab(tabId) { await chrome.tabs.reload(tabId); return { ok: true }; }
async function goBack(tabId)   { await chrome.tabs.goBack(tabId); return { ok: true }; }
async function goForward(tabId){ await chrome.tabs.goForward(tabId); return { ok: true }; }

/* ---------- Router de mensajes ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const { type, payload } = msg || {};
      let data;
      switch (type) {
        case 'ping':           data = { version: VERSION, ok: true }; break;
        case 'tabs.list':      data = await listTabs(); break;
        case 'tabs.activate':  data = await activateTab(payload.tabId); break;
        case 'tabs.close':     data = await closeTab(payload.tabId); break;
        case 'tabs.open':      data = await openTab(payload); break;
        case 'tabs.read':      data = await readTab(payload); break;
        case 'tabs.control': {
          if (payload.action === 'reload')  data = await reloadTab(payload.tabId);
          else if (payload.action === 'back')    data = await goBack(payload.tabId);
          else if (payload.action === 'forward') data = await goForward(payload.tabId);
          else data = await controlTab(payload);
          break;
        }
        default: throw new Error('tipo de mensaje no soportado: ' + type);
      }
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async
});

/* ---------- Eventos espontáneos (notificar a la web) ---------- */
async function broadcastEventToJarvisTabs(event, data) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.id) continue;
      const u = t.url || '';
      // sólo enviamos a pestañas que MATCHEAN nuestros content scripts
      if (!/vercel\.app|localhost|127\.0\.0\.1|emergentagent\.com/.test(u)) continue;
      try { chrome.tabs.sendMessage(t.id, { type: 'ext-event', event, data }); } catch {}
    }
  } catch {}
}
chrome.tabs.onActivated.addListener((info) => broadcastEventToJarvisTabs('tab.activated', info));
chrome.tabs.onRemoved.addListener((tabId, info)  => broadcastEventToJarvisTabs('tab.removed', { tabId, info }));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' || change.title || change.url) {
    broadcastEventToJarvisTabs('tab.updated', { tabId, title: tab.title, url: tab.url });
  }
});

console.log('[J.A.R.V.I.S. ext] background ready v' + VERSION);
