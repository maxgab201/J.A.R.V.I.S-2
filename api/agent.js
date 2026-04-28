/**
 * /api/agent — Vercel Serverless Function
 * Proxy seguro al modelo Gemini 2.5 Flash.
 * - Recibe historial de chat + system prompt
 * - Llama a Google Generative Language API con la GEMINI_API_KEY (env var)
 * - Devuelve la respuesta del modelo
 *
 * Body esperado:
 *   { messages: [{role: 'user'|'jarvis', text: string}, ...], systemPrompt?: string }
 * Respuesta:
 *   { reply: string }
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor' });
  }

  // body parsing (defensive — Vercel a veces parsea, a veces no)
  const body = await readBody(req);
  const { messages = [], systemPrompt } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages vacío o inválido' });
  }

  // Convertir historial a formato Gemini (user / model)
  const contents = messages
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .map(m => ({
      role: m.role === 'jarvis' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));

  // Gemini exige que el último turno sea 'user'
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'el último mensaje debe ser del usuario' });
  }

  const payload = {
    contents,
    generationConfig: {
      temperature: 0.75,
      topP: 0.95,
      maxOutputTokens: 600,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  if (systemPrompt && typeof systemPrompt === 'string') {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  try {
    const r = await fetch(`${ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(r.status).json({
        error: 'Gemini API error',
        status: r.status,
        details: safeTrim(errTxt, 500),
      });
    }

    const data = await r.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim();
    if (!reply) {
      return res.status(502).json({
        error: 'Respuesta vacía del modelo',
        finishReason: data?.candidates?.[0]?.finishReason || 'unknown',
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ reply, model: MODEL });
  } catch (e) {
    return res.status(500).json({ error: 'Error de red al contactar Gemini', message: String(e?.message || e) });
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // raw stream
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function safeTrim(s, max) { return (s || '').slice(0, max); }
