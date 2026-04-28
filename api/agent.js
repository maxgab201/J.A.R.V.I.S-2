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
    // Sobrescribe los parámetros generales para este modelo (Nemotron exige max_tokens alto)
    gen: { temperature: 1, top_p: 0.95, max_tokens: 4096 },
    // Parámetros extra propios de NVIDIA (modo "thinking" con reasoning budget)
    extraBody: {
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: 16384,
    },
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

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readBody(req);
  const { messages = [], systemPrompt } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages vacío o inválido' });
  }
  if (messages[messages.length - 1].role !== 'user' && messages[messages.length - 1].role !== undefined) {
    // permitir sin role explícito
  }

  const fallbackChain = [];
  for (const p of PROVIDERS) {
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

  // NVIDIA Nemotron tarda más que el resto cuando piensa: damos hasta 60s
  const timeoutMs = p.name === 'nvidia' ? 60000 : 30000;

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
