/**
 * /api/transcribe — Vercel Serverless Function
 *
 * Si RAILWAY_TRANSCRIBE_URL está configurada:
 *   → reenvía el audio a Railway (FastAPI + faster-whisper)
 * Si no:
 *   → fallback a Gemini 2.5 Flash (útil en desarrollo local sin Railway)
 *
 * El frontend siempre llama a /api/transcribe — nunca habla con Railway directo.
 * Esto mantiene la URL de Railway como secreto de servidor.
 *
 * Body esperado:  { audioBase64: string, mimeType?: string }
 * Respuesta:      { text: string }
 */

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readBody(req);
  const { audioBase64, mimeType = 'audio/webm' } = body || {};

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'audioBase64 faltante' });
  }

  const railwayUrl = process.env.RAILWAY_TRANSCRIBE_URL;

  if (railwayUrl) {
    return transcribeViaRailway(req, res, audioBase64, mimeType, railwayUrl);
  } else {
    return transcribeViaGemini(req, res, audioBase64, mimeType);
  }
}

// ─── Railway path ─────────────────────────────────────────────────────────────
async function transcribeViaRailway(req, res, audioBase64, mimeType, railwayUrl) {
  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Construir multipart/form-data manualmente (Node.js sin dependencias)
    const boundary = '----JarvisBoundary' + Date.now().toString(36);
    const extMap = {
      'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
      'audio/wave': 'wav',  'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
      'audio/flac': 'flac',
    };
    const ext = extMap[mimeType.split(';')[0]] || 'webm';

    const parts = [];
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
      `Content-Type: ${mimeType.split(';')[0]}\r\n\r\n`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const formBody = Buffer.concat(parts);

    const endpoint = railwayUrl.replace(/\/$/, '') + '/transcribe';
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(formBody.length),
      },
      body: formBody,
      signal: AbortSignal.timeout(25000), // 25s máximo
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('[transcribe→railway] HTTP', r.status, errText.slice(0, 200));
      return res.status(r.status >= 500 ? 503 : r.status).json({
        error: `Railway HTTP ${r.status}`,
        detail: errText.slice(0, 200),
      });
    }

    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      text: data.text || '',
      provider: 'railway-whisper',
    });
  } catch (e) {
    console.error('[transcribe→railway] Error:', e.message);
    return res.status(503).json({ error: 'Railway no disponible: ' + e.message });
  }
}

// ─── Gemini fallback (desarrollo local sin Railway) ───────────────────────────
async function transcribeViaGemini(req, res, audioBase64, mimeType) {
  const MODEL    = 'gemini-2.5-flash';
  const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);

  if (!keys.length) {
    return res.status(500).json({ error: 'Sin Railway ni Gemini configurados' });
  }

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'Transcribe exactamente al español el audio adjunto. Devuelve únicamente la transcripción literal, sin agregar comentarios, sin comillas, sin formato markdown, sin explicaciones. Si el audio está en silencio o no contiene voz inteligible, responde con un único guion: -' },
        { inlineData: { mimeType, data: audioBase64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 400 },
  };

  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await fetch(`${ENDPOINT}?key=${keys[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) continue;
      const data = await r.json();
      let text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('').trim() || '';
      if (text === '-' || !text) text = '';
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ text, provider: 'gemini', model: MODEL });
    } catch { /* next key */ }
  }
  return res.status(503).json({ error: 'Gemini falló en todas las keys' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
