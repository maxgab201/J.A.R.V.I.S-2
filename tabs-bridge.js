/* ============================================================
   tabs-bridge.js — Comunicación con otras pestañas
   ────────────────────────────────────────────────────────────
   PARTE A) Pestañas DEL MISMO SITIO (PC + móvil)
     - BroadcastChannel para chat/eventos en tiempo real
     - localStorage para sesión compartida (chatHistory, settings)

   PARTE B) OTRAS pestañas DEL NAVEGADOR (solo PC, requiere extensión)
     - Detección de extensión J.A.R.V.I.S. Tab Controller
     - Mensajería via window.postMessage (la extensión inyecta un
       content script que hace puente con su service worker).

   Expone un objeto global `TabsBridge` con métodos asíncronos.
   ============================================================ */
(function () {
  'use strict';

  const BC_NAME = 'jarvis-mark-vii-bus';
  const SESSION_KEY = 'jarvis.session.v1';
  const TAB_ID = (() => {
    try {
      const k = 'jarvis.tab.id';
      let v = sessionStorage.getItem(k);
      if (!v) {
        v = 't_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
        sessionStorage.setItem(k, v);
      }
      return v;
    } catch { return 't_' + Date.now().toString(36); }
  })();

  /* ---------- Event emitter mínimo ---------- */
  const listeners = new Map();
  function on(event, cb)  { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(cb); return () => off(event, cb); }
  function off(event, cb) { listeners.get(event)?.delete(cb); }
  function emit(event, payload) { listeners.get(event)?.forEach(cb => { try { cb(payload); } catch (e) { console.warn('[tabs-bridge] listener', e); } }); }

  /* ============================================================
     A) BroadcastChannel (mismo origen) — funciona en PC y móvil
     ============================================================ */
  let bc = null;
  const peers = new Map(); // tabId -> { name, lastSeen }
  let peerName = 'Pestaña-' + TAB_ID.slice(2, 6).toUpperCase();

  function setPeerName(name) {
    peerName = String(name || '').trim() || peerName;
    announce();
  }

  function bcSend(type, data) {
    const msg = { type, from: TAB_ID, name: peerName, t: Date.now(), data };
    try { bc?.postMessage(msg); } catch (e) { /* ignore */ }
    // Fallback: localStorage event (Safari iOS antiguos sin BroadcastChannel)
    try {
      if (!('BroadcastChannel' in window)) {
        localStorage.setItem('jarvis.bus.msg', JSON.stringify(msg));
        localStorage.removeItem('jarvis.bus.msg');
      }
    } catch {}
  }

  function announce() { bcSend('hello', null); }

  function handleBcMessage(msg) {
    if (!msg || msg.from === TAB_ID) return;
    const peer = peers.get(msg.from) || {};
    peer.name = msg.name || peer.name || ('Pestaña-' + msg.from.slice(2, 6));
    peer.lastSeen = Date.now();
    peers.set(msg.from, peer);

    switch (msg.type) {
      case 'hello':
        bcSend('hello-ack', null);
        emit('peer:join', { id: msg.from, name: peer.name });
        break;
      case 'hello-ack':
        emit('peer:join', { id: msg.from, name: peer.name });
        break;
      case 'bye':
        peers.delete(msg.from);
        emit('peer:leave', { id: msg.from, name: peer.name });
        break;
      case 'chat':
        emit('peer:chat', { from: msg.from, name: peer.name, text: String(msg.data?.text || ''), time: msg.t });
        break;
      case 'session-update':
        // otra pestaña actualizó la sesión compartida → notificar
        emit('session:remote-update', msg.data || {});
        break;
      case 'state':
        emit('peer:state', { from: msg.from, name: peer.name, state: msg.data || {} });
        break;
      default:
        emit('peer:message', { from: msg.from, name: peer.name, type: msg.type, data: msg.data, time: msg.t });
    }
  }

  function initBroadcast() {
    try {
      if ('BroadcastChannel' in window) {
        bc = new BroadcastChannel(BC_NAME);
        bc.onmessage = (e) => handleBcMessage(e.data);
      } else {
        // fallback localStorage
        window.addEventListener('storage', (e) => {
          if (e.key === 'jarvis.bus.msg' && e.newValue) {
            try { handleBcMessage(JSON.parse(e.newValue)); } catch {}
          }
        });
      }
    } catch (e) { console.warn('[tabs-bridge] BC init', e); }

    // Anunciarse y limpiar peers viejos
    announce();
    setInterval(announce, 8000);
    setInterval(() => {
      const now = Date.now();
      for (const [id, p] of peers) {
        if (now - p.lastSeen > 25000) { peers.delete(id); emit('peer:leave', { id, name: p.name }); }
      }
    }, 5000);
    window.addEventListener('beforeunload', () => bcSend('bye', null));
  }

  /* ---------- API pública A) ---------- */
  function listPeers() {
    return Array.from(peers.entries()).map(([id, p]) => ({ id, name: p.name, lastSeen: p.lastSeen }));
  }
  function sendChatToPeers(text) {
    if (!text) return;
    bcSend('chat', { text: String(text) });
  }
  function broadcastState(state) { bcSend('state', state || {}); }

  /* ============================================================
     SESIÓN COMPARTIDA (localStorage + storage events)
     - chatHistory, settings (TTS enabled, tema, etc.)
     ============================================================ */
  const Session = {
    load() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') || {}; }
      catch { return {}; }
    },
    save(obj) {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(obj || {}));
        bcSend('session-update', { keys: Object.keys(obj || {}) });
      } catch (e) { console.warn('[tabs-bridge] session save', e); }
    },
    patch(partial) {
      const cur = Session.load();
      const next = { ...cur, ...partial, updatedAt: Date.now(), updatedBy: TAB_ID };
      Session.save(next);
      return next;
    },
    clear() {
      try { localStorage.removeItem(SESSION_KEY); bcSend('session-update', { cleared: true }); } catch {}
    },
  };
  // Auto-detectar cambios de localStorage de OTRAS pestañas
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY) emit('session:storage', { newValue: e.newValue });
  });

  /* ============================================================
     B) EXTENSIÓN — control de OTRAS pestañas del navegador
     ────────────────────────────────────────────────────────────
     Protocolo:
       Web → Extensión:  window.postMessage({ source:'jarvis-web', id, type, payload })
       Extensión → Web:  window.postMessage({ source:'jarvis-ext', id, ok, data, error })
     La extensión hace document.dispatchEvent('jarvis-ext-ready') al inyectarse.
     ============================================================ */
  let extReady = false;
  let extInfo = null;
  const pending = new Map();
  let reqSeq = 0;

  function nextId() { reqSeq = (reqSeq + 1) % 1e9; return 'r_' + Date.now().toString(36) + '_' + reqSeq; }

  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.source !== window) return;
    const m = ev.data;
    if (m.source !== 'jarvis-ext') return;

    if (m.type === 'ready') {
      extReady = true;
      extInfo = m.payload || { version: '?' };
      emit('ext:ready', extInfo);
      return;
    }
    if (m.type === 'event') {
      // eventos espontáneos (tab activated, removed, etc.)
      emit('ext:event', { event: m.event, data: m.data });
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      if (m.ok) resolve(m.data);
      else reject(new Error(m.error || 'Extensión: error desconocido'));
    }
  });

  // Listener alternativo: la extensión puede emitir un CustomEvent al inyectarse
  document.addEventListener('jarvis-ext-ready', (ev) => {
    extReady = true;
    extInfo = (ev.detail || { version: '?' });
    emit('ext:ready', extInfo);
  });

  function extCall(type, payload, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!extReady) return reject(new Error('Extensión no instalada o no detectada'));
      const id = nextId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Timeout esperando respuesta de la extensión'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: 'jarvis-web', id, type, payload }, '*');
    });
  }

  /* ---------- API pública B) ---------- */
  const Ext = {
    isReady() { return extReady; },
    info() { return extInfo; },
    listTabs() { return extCall('tabs.list'); },
    activateTab(tabId) { return extCall('tabs.activate', { tabId }); },
    closeTab(tabId) { return extCall('tabs.close', { tabId }); },
    openTab(url, active = true) { return extCall('tabs.open', { url, active }); },
    readTab(tabId, opts = {}) { return extCall('tabs.read', { tabId, ...opts }); },
    /**
     * Acción genérica sobre una pestaña.
     * action ∈ { play, pause, scrollTop, scrollBottom, scrollBy, click, type, reload, back, forward, getTitle, getUrl, query, screenshot }
     */
    controlTab(tabId, action, args = {}) { return extCall('tabs.control', { tabId, action, args }); },
    sendKey(tabId, key) { return extCall('tabs.control', { tabId, action: 'sendKey', args: { key } }); },
    pingExt() { return extCall('ping', null, 2000); },
  };

  /* ============================================================
     INICIALIZACIÓN
     ============================================================ */
  initBroadcast();

  // Probe extensión: enviar un ping; si responde dentro de 1.5s queda lista
  setTimeout(async () => {
    try {
      // si la extensión inyecta el bridge, responderá al postMessage 'probe'
      const id = nextId();
      const timer = setTimeout(() => { pending.delete(id); }, 1500);
      pending.set(id, { resolve: (info) => { extReady = true; extInfo = info; emit('ext:ready', info); }, reject: () => {}, timer });
      window.postMessage({ source: 'jarvis-web', id, type: 'ping', payload: null }, '*');
    } catch {}
  }, 400);

  /* ---------- Exponer global ---------- */
  window.TabsBridge = {
    tabId: TAB_ID,
    setName: setPeerName,
    on, off,
    // mismo sitio
    listPeers,
    sendChat: sendChatToPeers,
    broadcastState,
    Session,
    // extensión
    ext: Ext,
  };
})();
