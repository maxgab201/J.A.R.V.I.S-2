/**
 * /api/tts — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * TTS multimodelo con cadena de fallback:
 *   1. NVIDIA Magpie TTS Multilingual (gRPC vía NVCF)
 *   2. Gemini 2.5 Flash Preview TTS (REST nativo Google)
 *
 * Body esperado:  { text: string, voice?: string, style?: string, language?: string }
 * Respuesta:      { audioBase64, mimeType, sampleRate, voice, model, provider }
 *
 * Variables de entorno:
 *   NVIDIA_API_KEY         (primario)
 *   GEMINI_API_KEY         (fallback)
 *   GEMINI_API_KEY_2       (fallback secundaria de Gemini)
 *   GEMINI_TTS_MODEL       (default: gemini-2.5-flash-preview-tts)
 *   GEMINI_TTS_VOICE       (default: Charon)
 *   NVIDIA_TTS_VOICE       (default: Magpie-Multilingual.ES-US.Diego)
 *   NVIDIA_TTS_LANGUAGE    (default: es-US)
 */

import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, 'proto', 'riva_tts.proto');

/* ============================================================
   NVIDIA Magpie TTS — gRPC sobre NVCF
   ============================================================ */
const NVCF_HOST = 'grpc.nvcf.nvidia.com:443';
const NVCF_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969'; // magpie-tts-multilingual
const NVIDIA_DEFAULT_VOICE = process.env.NVIDIA_TTS_VOICE || 'Magpie-Multilingual.ES-US.Diego';
const NVIDIA_DEFAULT_LANG  = process.env.NVIDIA_TTS_LANGUAGE || 'es-US';
const NVIDIA_SAMPLE_RATE   = 22050;

let _ttsClient = null;
function getNvidiaClient() {
  if (_ttsClient) return _ttsClient;
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def);
  const Service = proto.nvidia.riva.tts.RivaSpeechSynthesis;
  _ttsClient = new Service(NVCF_HOST, grpc.credentials.createSsl());
  return _ttsClient;
}

function nvidiaSynthesize({ text, voice, language, sampleRateHz }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY no configurada');

  const client = getNvidiaClient();
  const metadata = new grpc.Metadata();
  metadata.add('authorization', `Bearer ${apiKey}`);
  metadata.add('function-id', NVCF_FUNCTION_ID);

  // Si la voz no es de la familia Magpie/Riva (ej: vino una de Gemini como
  // "Charon"), caemos al default de NVIDIA. Sólo aceptamos voces compatibles.
  const isNvidiaVoice = typeof voice === 'string' && /^(Magpie-|English-US\.|Spanish-US\.|Riva)/i.test(voice);
  const finalVoice = isNvidiaVoice ? voice : NVIDIA_DEFAULT_VOICE;

  const request = {
    text,
    language_code: language || NVIDIA_DEFAULT_LANG,
    encoding: 'LINEAR_PCM',
    sample_rate_hz: sampleRateHz || NVIDIA_SAMPLE_RATE,
    voice_name: finalVoice,
  };

  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 25000);
    client.Synthesize(request, metadata, { deadline }, (err, response) => {
      if (err) return reject(err);
      const audio = response?.audio;
      if (!audio || (Buffer.isBuffer(audio) ? audio.length : audio.byteLength) === 0) {
        return reject(new Error('NVIDIA TTS: respuesta sin audio'));
      }
      const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
      resolve({
        audioBase64: buf.toString('base64'),
        mimeType: `audio/L16;codec=pcm;rate=${request.sample_rate_hz}`,
        sampleRate: request.sample_rate_hz,
        voice: request.voice_name,
        model: 'magpie-tts-multilingual',
        provider: 'nvidia',
      });
    });
  });
}

/* ============================================================
   Gemini TTS — REST (igual que antes, ahora como fallback)
   ============================================================ */
const GEMINI_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_DEFAULT_VOICE = process.env.GEMINI_TTS_VOICE || 'Charon';
const GEMINI_DEFAULT_STYLE = 'Hablá en español neutro latinoamericano, con tono sofisticado, calmo, profesional y ligeramente formal, como J.A.R.V.I.S. de Iron Man. Pausas naturales, dicción clara, sin acelerar.';

async function geminiSynthesize({ text, voice, style }) {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  if (!keys.length) throw new Error('GEMINI_API_KEY no configurada');

  const promptText = `${style || GEMINI_DEFAULT_STYLE}\n\n${text}`;
  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || GEMINI_DEFAULT_VOICE } } },
    },
  };

  const errs = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await fetch(`${GEMINI_ENDPOINT}?key=${keys[i]}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        errs.push(`gemini key#${i+1}: HTTP ${r.status} ${t.slice(0, 120)}`);
        continue;
      }
      const data = await r.json();
      const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part?.inlineData?.data) {
        errs.push(`gemini key#${i+1}: sin audio (${data?.candidates?.[0]?.finishReason || 'unknown'})`);
        continue;
      }
      const mimeType = part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000';
      const sampleRate = parseInt(/rate=(\d+)/.exec(mimeType)?.[1] || '24000', 10);
      return {
        audioBase64: part.inlineData.data,
        mimeType,
        sampleRate,
        voice: voice || GEMINI_DEFAULT_VOICE,
        model: GEMINI_MODEL,
        provider: 'gemini',
        keyIdx: i + 1,
      };
    } catch (e) {
      errs.push(`gemini key#${i+1}: ${String(e.message || e).slice(0, 120)}`);
    }
  }
  throw new Error('Gemini TTS falló en todas las keys: ' + errs.join(' | '));
}

/* ============================================================
   Handler
   ============================================================ */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = await readBody(req);
  const { text, voice, style, language, skipProviders = [] } = body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text requerido' });
  if (text.length > 4000) return res.status(400).json({ error: 'text demasiado largo (>4000 chars)' });
  const skipSet = new Set((Array.isArray(skipProviders) ? skipProviders : []).map(s => String(s).toLowerCase()));

  const fallbackChain = [];

  // 1) NVIDIA Magpie
  if (!skipSet.has('nvidia') && process.env.NVIDIA_API_KEY) {
    try {
      const result = await nvidiaSynthesize({ text, voice, language });
      fallbackChain.push({ provider: 'nvidia', status: 'ok' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ...result, fallbackChain });
    } catch (e) {
      fallbackChain.push({ provider: 'nvidia', status: 'error', error: shorten(e.message || String(e), 200) });
      // sigue al fallback
    }
  } else if (!skipSet.has('nvidia')) {
    fallbackChain.push({ provider: 'nvidia', status: 'no-key' });
  } else {
    fallbackChain.push({ provider: 'nvidia', status: 'skipped' });
  }

  // 2) Gemini fallback
  if (!skipSet.has('gemini')) {
    try {
      const result = await geminiSynthesize({ text, voice, style });
      fallbackChain.push({ provider: 'gemini', status: 'ok' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ...result, fallbackChain });
    } catch (e) {
      fallbackChain.push({ provider: 'gemini', status: 'error', error: shorten(e.message || String(e), 200) });
    }
  } else {
    fallbackChain.push({ provider: 'gemini', status: 'skipped' });
  }

  return res.status(503).json({ error: 'TTS falló en todos los proveedores', fallbackChain });
}

/* ============================================================
   Helpers
   ============================================================ */
function shorten(s, n) { return String(s || '').slice(0, n); }

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
