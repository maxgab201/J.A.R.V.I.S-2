/**
 * /api/agent — Vercel Serverless Function
 * ───────────────────────────────────────────────────────────────
 * Cadena de fallback multi-proveedor: si uno falla (429, 5xx, red),
 * salta automáticamente al siguiente.
 *
 * Orden de proveedores:
 *   1. NVIDIA      (nvidia/nemotron-3-super-120b-a12b) ← reasoning, gratis
 *   2. Gemini #1   (gemini-2.0-flash)  ← 15 RPM · 1500 RPD
 *   3. Gemini #2   (gemini-2.0-flash)  ← 15 RPM · 1500 RPD (key separada)
 *   4. Mistral     (mistral-large-latest) ← 2 RPM · 1B tokens/mes
 *   5. OpenRouter  (llama-3.3-70b-instruct:free) ← 20 RPM · 200 RPD
 *   6. Hugging Face (Llama-3.3-70B vía router) ← créditos pequeños
 *
 * Body esperado:  { messages, systemPrompt? }
 * Respuesta:      { reply, provider, model, fallbackChain? }
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const PROVIDERS = [
  {
    name: 'nvidia',
    kind: 'openai',
    model: 'nvidia/nemotron-3-super-120b-a12b',
    keyEnv: 'NVIDIA_API_KEY',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    // Sobrescribe los parámetros generales (Nemotron + thinking)
    // El reasoning_budget y enable_thinking se ajustan DINÁMICAMENTE por
    // mensaje (ver applyAdaptiveReasoning) — estos son sólo defaults.
    gen: { temperature: 1, top_p: 0.95, max_tokens: 1500 },
    extraBody: {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 1500,
    },
    adaptiveReasoning: true, // ← marca para activar la heurística
  },
  {
    name: 'gemini-1',
    kind: 'gemini',
    model: GEMINI_MODEL,
    keyEnv: 'GEMINI_API_KEY',
  },
  {
    name: 'gemini-2',
    kind: 'gemini',
    model: GEMINI_MODEL,
    keyEnv: 'GEMINI_API_KEY_2',
  },
  {
    name: 'mistral',
    kind: 'openai',
    model: 'mistral-large-latest',
    keyEnv: 'MISTRAL_API_KEY',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
  },
  {
    name: 'openrouter',
    kind: 'openai',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    extraHeaders: {
      'HTTP-Referer': 'https://jarvis-mark-vii.vercel.app',
      'X-Title': 'JARVIS Mark VII Interface',
    },
  },
  {
    name: 'huggingface',
    kind: 'openai',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    keyEnv: 'HUGGINGFACE_API_KEY',
    endpoint: 'https://router.huggingface.co/v1/chat/completions',
  },
];

const COMMON_GEN = { temperature: 0.75, max_tokens: 600, top_p: 0.95 };

/* ============================================================
   HEURÍSTICA DE RAZONAMIENTO ADAPTATIVO (sólo para NVIDIA)
   ────────────────────────────────────────────────────────────
   Decide en el server si vale la pena que Nemotron piense, y cuánto:
     OFF    → saludos, comandos directos triviales (sin thinking)
     LOW    → preguntas cortas, factual (~512 tokens de razonamiento)
     MEDIUM → conversación normal (~1500 tokens)  ← default
     HIGH   → problemas complejos, código, análisis (~4096 tokens)
   ============================================================ */
function detectReasoningLevel(messages) {
  // tomamos el último mensaje del usuario
  const last = [...messages].reverse().find(m => {
    const r = m && m.role;
    return !r || r === 'user';
  });
  const text = (last && last.text || '').trim();
  const len = text.length;
  const lower = text.toLowerCase();

  // OFF — saludos, agradecimientos, monosílabos
  const offMarkers = /^(hola|holi|holaa+|buenas|buen[oa]s? d[ií]as?|buen[oa]s? tardes|buen[oa]s? noches|buen d[ií]a|qu[eé] tal|c[oó]mo (estás|andas|va)|todo (bien|tranqui)|gracias|grax|ok|dale|listo|s[ií]|no|chau|adi[oó]s|nos vemos|hi|hello|hey|thanks)[\s\.\!\?]*$/i;
  if (offMarkers.test(text)) return { level: 'off', enable_thinking: false, reasoning_budget: 0 };

  // OFF — comandos directos del HUD: abrir url/app, listar/cerrar pestañas, mic
  // Usamos (?=\s|$|\W) en vez de \b porque la ñ y vocales acentuadas no son
  // word-chars en regex JS y \b no las trata como límite correcto.
  const directCmd = /^(abr[ií]|abrime|ir a|llev[aá]me|navegá|navegar|list[aá]|cerr[aá]|cambi[aá] a|activ[aá]|reproduc[ií]|paus[aá]|sub[ií] el volumen|baj[aá] el volumen|silenci[aá]|reload|recarg[aá]|mostr[aá]me|escuch[aá]|mut[eé])(?=\s|$|\W)/i;
  if (directCmd.test(text) && len < 80) return { level: 'off', enable_thinking: false, reasoning_budget: 0 };

  // LOW — mensajes muy cortos
  if (len < 30) return { level: 'low', enable_thinking: true, reasoning_budget: 512 };

  // HIGH — markers de razonamiento profundo
  const highMarkers = /\b(explic[aá]me?|explicá|por qu[eé]|comparár|comparar|comparame|análisis|analiz[aá]|calcul[aá]|resolv[eé]|estrategi[ao]|planificá|plan de|diseñ[aá]|c[oó]digo|programá|escribime un c[oó]digo|c[oó]mo (funciona|hago|implemento)|paso a paso|step by step|optimiz[aá]|debug|debug[ueé]a|raz[oó]ná|justific[aá]|demostr[aá]|prueb[aá]|why does|explain (how|why)|step\-by\-step)\b/i;
  if (highMarkers.test(lower)) return { level: 'high', enable_thinking: true, reasoning_budget: 4096 };

  // HIGH — operaciones matemáticas con varios pasos o textos largos
  const mathCount = (text.match(/[\+\-\*\/\=]/g) || []).length;
  if (mathCount >= 3 || len > 280) return { level: 'high', enable_thinking: true, reasoning_budget: 4096 };

  // MEDIUM — default (conversación común, una pregunta)
  return { level: 'medium', enable_thinking: true, reasoning_budget: 1500 };
}

/** Aplica la heurística a las opciones del proveedor (clona body) */
function applyAdaptiveReasoning(p, messages, body) {
  if (!p.adaptiveReasoning) return body;
  const dec = detectReasoningLevel(messages);
  // Mutamos chat_template_kwargs y reasoning_budget en el body
  body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: dec.enable_thinking };
  if (dec.enable_thinking) {
    body.reasoning_budget = dec.reasoning_budget;
  } else {
    delete body.reasoning_budget;
  }
  // Devolvemos también el nivel para loguear (no se manda al modelo)
  body.__reasoning_level = dec.level;
  return body;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readBody(req);
  const { messages = [], systemPrompt, stream: wantStream = false, skipProviders = [] } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages vacío o inválido' });
  }
  const skipSet = new Set((Array.isArray(skipProviders) ? skipProviders : []).map(s => String(s).toLowerCase()));
  // Calculamos el nivel de razonamiento UNA sola vez (depende sólo del último
  // mensaje del usuario, no del proveedor). Lo devolvemos al cliente para que
  // pueda mostrarlo en el log y, en el modo streaming, lo emitimos en el
  // evento `meta`.
  const nvidiaLevel = detectReasoningLevel(messages);

  /* ============================================================
     Modo STREAMING (sólo NVIDIA por ahora) — proxy SSE al cliente
     Si falla, automáticamente caemos a modo no-streaming.
     ============================================================ */
  if (wantStream && !skipSet.has('nvidia')) {
    const nvidia = PROVIDERS.find(p => p.name === 'nvidia');
    const nvKey = nvidia && process.env[nvidia.keyEnv];
    if (nvidia && nvKey) {
      const ok = await streamProxyOpenAI(nvidia, nvKey, messages, systemPrompt, res);
      if (ok) return; // ya enviamos toda la respuesta como SSE
      // si streamProxy ya escribió headers, no podemos volver atrás
      // (controlado dentro: solo retorna false si NO se enviaron headers)
    }
    // si no había NVIDIA o no hubo respuesta válida, seguimos en modo no-stream
  }

  const fallbackChain = [];
  for (const p of PROVIDERS) {
    if (skipSet.has(p.name)) {
      fallbackChain.push({ provider: p.name, status: 'skipped' });
      continue;
    }
    const key = process.env[p.keyEnv];
    if (!key) {
      fallbackChain.push({ provider: p.name, status: 'no-key' });
      continue;
    }
    try {
      const reply = await callProvider(p, key, messages, systemPrompt);
      if (reply && reply.trim()) {
        fallbackChain.push({ provider: p.name, status: 'ok' });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
          reply: reply.trim(),
          provider: p.name,
          model: p.model,
          fallbackChain,
          reasoningLevel: p.adaptiveReasoning ? nvidiaLevel.level : null,
        });
      }
      fallbackChain.push({ provider: p.name, status: 'empty' });
    } catch (e) {
      fallbackChain.push({ provider: p.name, status: 'error', error: shorten(e.message || String(e), 200) });
      // continúa al siguiente
    }
  }
  return res.status(503).json({
    error: 'Todos los proveedores fallaron o no tienen key configurada',
    fallbackChain,
  });
}

/* ============================================================
   STREAMING — proxy SSE OpenAI-compatible al cliente
   ─ Devuelve true si ya escribió la respuesta completa al cliente.
   ─ Devuelve false si NO escribió headers (todavía podemos hacer fallback).
   ============================================================ */
async function streamProxyOpenAI(p, key, messages, systemPrompt, res) {
  const oaiMessages = [];
  if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    const role = (m.role === 'jarvis' || m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user';
    oaiMessages.push({ role, content: m.text });
  }
  if (!oaiMessages.filter(x => x.role !== 'system').length) return false;

  const gen = { ...COMMON_GEN, ...(p.gen || {}) };
  const body = {
    model: p.model,
    messages: oaiMessages,
    temperature: gen.temperature,
    top_p: gen.top_p,
    max_tokens: gen.max_tokens,
    stream: true,
    ...(p.extraBody || {}),
  };
  // Aplica heurística adaptativa de razonamiento (sólo NVIDIA)
  applyAdaptiveReasoning(p, messages, body);
  const reasoningLevel = body.__reasoning_level;
  delete body.__reasoning_level;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 90000);
  let upstream;
  try {
    upstream = await fetch(p.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        ...(p.extraHeaders || {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(t);
    return false; // no escribimos headers, podemos fallbackear
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(t);
    return false;
  }

  // Headers SSE para el cliente
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Evento inicial con metadata de provider
  res.write(`event: meta\ndata: ${JSON.stringify({ provider: p.name, model: p.model, reasoningLevel })}\n\n`);

  // Reenvío del stream upstream → cliente, parseando los chunks SSE
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let aggregateContent = '';
  let aggregateReasoning = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Procesamos por líneas (SSE)
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          res.write(`event: done\ndata: ${JSON.stringify({ content: aggregateContent.trim(), reasoning: aggregateReasoning.length })}\n\n`);
          res.end();
          clearTimeout(t);
          return true;
        }
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta || {};
          const reasoning = delta.reasoning_content;
          const content = delta.content;
          if (reasoning) {
            aggregateReasoning += reasoning;
            res.write(`event: reasoning\ndata: ${JSON.stringify({ d: reasoning })}\n\n`);
          }
          if (content) {
            aggregateContent += content;
            res.write(`event: token\ndata: ${JSON.stringify({ d: content })}\n\n`);
          }
        } catch { /* ignore parse error */ }
      }
    }
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(e?.message || e) })}\n\n`);
  } finally {
    clearTimeout(t);
  }
  if (!res.writableEnded) {
    res.write(`event: done\ndata: ${JSON.stringify({ content: aggregateContent.trim(), reasoning: aggregateReasoning.length })}\n\n`);
    res.end();
  }
  return true;
}

/* ============================================================
   Provider dispatchers
   ============================================================ */
async function callProvider(p, key, messages, systemPrompt) {
  if (p.kind === 'gemini') return callGemini(p, key, messages, systemPrompt);
  if (p.kind === 'openai') return callOpenAI(p, key, messages, systemPrompt);
  throw new Error('kind desconocido: ' + p.kind);
}

/* --------- Gemini (REST nativo) --------- */
async function callGemini(p, key, messages, systemPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${key}`;
  const contents = messages
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => ({
      role: (m.role === 'jarvis' || m.role === 'model' || m.role === 'assistant') ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    throw new Error('último mensaje debe ser del usuario');
  }
  const payload = {
    contents,
    generationConfig: { temperature: COMMON_GEN.temperature, topP: COMMON_GEN.top_p, maxOutputTokens: COMMON_GEN.max_tokens },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  if (systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const r = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 25000);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Gemini ${r.status}: ${shorten(txt, 200)}`);
  }
  const data = await r.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map(part => part.text).join('').trim();
  if (!reply) throw new Error('Gemini respuesta vacía (' + (data?.candidates?.[0]?.finishReason || 'unknown') + ')');
  return reply;
}

/* --------- OpenAI-compatible (NVIDIA, Mistral, OpenRouter, HF Router) --------- */
async function callOpenAI(p, key, messages, systemPrompt) {
  const oaiMessages = [];
  if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
    const role = (m.role === 'jarvis' || m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user';
    oaiMessages.push({ role, content: m.text });
  }
  if (oaiMessages.filter(m => m.role !== 'system').length === 0) throw new Error('sin mensajes válidos');

  const headers = {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...(p.extraHeaders || {}),
  };
  const gen = { ...COMMON_GEN, ...(p.gen || {}) };
  const body = {
    model: p.model,
    messages: oaiMessages,
    temperature: gen.temperature,
    top_p: gen.top_p,
    max_tokens: gen.max_tokens,
    stream: false,
    ...(p.extraBody || {}),
  };
  // Aplica heurística adaptativa de razonamiento (sólo NVIDIA)
  applyAdaptiveReasoning(p, messages, body);
  delete body.__reasoning_level; // marker interno, no debe ir al endpoint

  // NVIDIA Nemotron tarda más cuando piensa, pero limitamos a 25s para
  // dar tiempo a que el fallback (Gemini/Mistral/etc.) complete dentro
  // del maxDuration de Vercel (60s). Los demás proveedores: 30s.
  const timeoutMs = p.name === 'nvidia' ? 25000 : 30000;

  const r = await timedFetch(p.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs);
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${p.name} ${r.status}: ${shorten(txt, 200)}`);
  }
  const data = await r.json();
  let reply = data?.choices?.[0]?.message?.content;
  // Algunos modelos con "thinking" devuelven el razonamiento en otro campo;
  // si content viene vacío, usamos reasoning_content como fallback.
  if ((!reply || !reply.trim()) && data?.choices?.[0]?.message?.reasoning_content) {
    reply = data.choices[0].message.reasoning_content;
  }
  if (!reply || !reply.trim()) throw new Error(`${p.name}: respuesta vacía`);
  // Algunos modelos emiten <think>...</think> al inicio aunque pidamos no thinking;
  // los limpiamos antes de devolver al cliente.
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!reply) throw new Error(`${p.name}: respuesta vacía tras limpiar thinking`);
  return reply;
}

/* ============================================================
   Helpers
   ============================================================ */
async function timedFetch(url, opts, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally { clearTimeout(t); }
}
function shorten(s, n) { return String(s || '').slice(0, n); }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
