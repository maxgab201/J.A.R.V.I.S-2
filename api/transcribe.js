/**
 * /api/transcribe — Vercel Serverless Function
 * Transcripción de audio vía Gemini 2.5 Flash (multimodal).
 * Necesario porque Brave bloquea webkitSpeechRecognition por privacidad.
 *
 * Body esperado:
 *   { audioBase64: string, mimeType?: string }
 * Respuesta:
 *   { text: string }
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Permitir hasta 8MB de audio en el body
export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

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

  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada' });
  }

  const body = await readBody(req);
  const { audioBase64, mimeType = 'audio/webm' } = body || {};
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'audioBase64 faltante' });
  }

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe exactamente al español el audio adjunto. Devuelve únicamente la transcripción literal, sin agregar comentarios, sin comillas, sin formato markdown, sin explicaciones. Si el audio está en silencio o no contiene voz inteligible, responde con un único guion: -' },
        { inlineData: { mimeType, data: audioBase64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 400,
    },
  };

  const errs = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await fetch(`${ENDPOINT}?key=${keys[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        errs.push(`key#${i+1}: HTTP ${r.status} ${txt.slice(0, 100)}`);
        continue;
      }
      const data = await r.json();
      let text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
      if (text === '-' || !text) text = '';
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ text, model: MODEL, keyIdx: i + 1 });
    } catch (e) {
      errs.push(`key#${i+1}: ${String(e.message || e).slice(0, 100)}`);
    }
  }
  return res.status(503).json({ error: 'Transcripción falló en todas las keys', tried: errs });
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
