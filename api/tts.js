/**
 * /api/tts — Vercel Serverless Function
 * Síntesis de voz vía Gemini 2.5 Flash Preview TTS (voz nativa neural).
 * Usa la misma GEMINI_API_KEY que /api/agent.
 *
 * Body esperado:
 *   { text: string, voice?: string, style?: string }
 * Respuesta:
 *   { audioBase64: string, mimeType: string, sampleRate: number }
 *
 * Voces recomendadas para tono JARVIS (deep, calmo, sofisticado):
 *   Charon (profunda) · Algenib (gravelly) · Sadaltager (knowledgeable)
 *   Iapetus (clear)   · Orus              · Alnilam (firm)
 */

const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || 'Charon';
const DEFAULT_STYLE = 'Hablá en español neutro latinoamericano, con tono sofisticado, calmo, profesional y ligeramente formal, como J.A.R.V.I.S. de Iron Man. Pausas naturales, dicción clara, sin acelerar.';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Probamos las 2 keys de Gemini (la de TTS necesita preview-tts, sólo Gemini lo hace gratis)
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) return res.status(500).json({ error: 'GEMINI_API_KEY no configurada' });

  const body = await readBody(req);
  const { text, voice = DEFAULT_VOICE, style = DEFAULT_STYLE } = body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
  if (text.length > 4000) return res.status(400).json({ error: 'text demasiado largo (>4000 chars)' });

  const promptText = `${style}\n\n${text}`;
  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };

  const errs = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const r = await fetch(`${ENDPOINT}?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        errs.push(`key#${i+1}: HTTP ${r.status} ${t.slice(0, 120)}`);
        continue;
      }
      const data = await r.json();
      const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part?.inlineData?.data) {
        errs.push(`key#${i+1}: sin audio (${data?.candidates?.[0]?.finishReason || 'unknown'})`);
        continue;
      }
      const mimeType = part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000';
      const sampleRate = parseSampleRate(mimeType);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        audioBase64: part.inlineData.data,
        mimeType,
        sampleRate,
        voice,
        model: MODEL,
        keyIdx: i + 1,
      });
    } catch (e) {
      errs.push(`key#${i+1}: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  return res.status(503).json({ error: 'TTS falló en todas las keys', tried: errs });
}

function parseSampleRate(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? parseInt(m[1], 10) : 24000;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
