/**
 * /api/transcribe-groq — Vercel Serverless Function
 * Transcripción ultra-rápida vía Groq Whisper (whisper-large-v3-turbo).
 * Pensada para el modo "always listening" (wake word):
 *   recibe segmentos cortos de audio (2-8s) y devuelve texto rápido (~300ms).
 *
 * Body esperado:
 *   { audioBase64: string, mimeType?: string, language?: string }
 * Respuesta:
 *   { text: string, provider: "groq", model: string }
 */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';

// Permitir hasta 4MB de audio (segmentos cortos de wake word)
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY no configurada' });
  }

  const body = await readBody(req);
  const { audioBase64, mimeType = 'audio/webm', language = 'es' } = body || {};
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return res.status(400).json({ error: 'audioBase64 faltante' });
  }

  try {
    // Convertir base64 a Buffer para enviar como multipart/form-data
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Determinar extensión para el nombre de archivo
    const extMap = {
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mp4': 'mp4',
      'audio/mpeg': 'mp3',
      'audio/wav': 'wav',
      'audio/flac': 'flac',
    };
    const ext = extMap[mimeType.split(';')[0]] || 'webm';

    // Construir FormData manualmente para Node.js (sin dependencias)
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const parts = [];

    // Campo: file
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
      `Content-Type: ${mimeType.split(';')[0]}\r\n\r\n`
    );
    parts.push(audioBuffer);
    parts.push('\r\n');

    // Campo: model
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${MODEL}\r\n`
    );

    // Campo: language
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="language"\r\n\r\n` +
      `${language}\r\n`
    );

    // Campo: response_format
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    );

    // Campo: temperature (baja para precisión)
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="temperature"\r\n\r\n` +
      `0.0\r\n`
    );

    parts.push(`--${boundary}--\r\n`);

    // Combinar partes en un solo Buffer
    const bodyParts = parts.map(p =>
      typeof p === 'string' ? Buffer.from(p, 'utf-8') : p
    );
    const bodyBuffer = Buffer.concat(bodyParts);

    const r = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(bodyBuffer.length),
      },
      body: bodyBuffer,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('[transcribe-groq] Groq error:', r.status, errText.slice(0, 200));
      return res.status(r.status >= 500 ? 503 : r.status).json({
        error: `Groq Whisper HTTP ${r.status}`,
        detail: errText.slice(0, 200),
      });
    }

    const data = await r.json();
    const text = (data.text || '').trim();

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      text,
      provider: 'groq',
      model: MODEL,
    });
  } catch (e) {
    console.error('[transcribe-groq] Error:', e.message || e);
    return res.status(503).json({
      error: 'Error en transcripción Groq: ' + (e.message || String(e)).slice(0, 150),
    });
  }
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
