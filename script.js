/* ============================================================
   J.A.R.V.I.S. — MARK VII INTERFACE
   Vanilla JS — sin dependencias externas
   ============================================================ */

/* ============================================================
   1. CONFIG — valores configurables
   ============================================================ */
const CONFIG = {
  sphere: {
    points: 800,
    rotationSpeed: 0.003,
    breatheBase: 82,
    breatheAmp: 8,
    pointSize: 2.2,
    focalLength: 260,
  },
  particles: { count: 60, speedMin: 0.15, speedMax: 0.7 },
  network:   { history: 60, updateMs: 1000 },
  metrics:   { updateMs: 2000 },
  logs:      { intervalMin: 3000, intervalMax: 5000, maxLines: 80 },
  chat:      { typewriterMs: 30, maxHistory: 10 },
  glitch:    { minMs: 8000, maxMs: 15000 },
};

/* ============================================================
   2. STATE — estado global
   ============================================================ */
const STATE = {
  sphereMode: 'idle',          // 'idle' | 'listening' | 'processing' | 'speaking'
  micActive: false,
  chatHistory: [],             // {role, text, time}
  cmdHistory: [],              // strings (último al inicio)
  agentConnected: false,
  metrics: {
    cpu: 35, cpuTarget: 35,
    cores: [30, 40, 28, 50],
    coresTarget: [30, 40, 28, 50],
    ram: 45, ramTarget: 45,
    diskC: 62, diskD: 35,
    tempCpu: 52, tempGpu: 67, tempMb: 38,
    tempCpuT: 52, tempGpuT: 67, tempMbT: 38,
    netDl: 45, netUl: 12,
    load: 30, loadTarget: 30,
  },
  netHistory: { dl: [], ul: [] },
  audioCtx: null,
};

/* ============================================================
   UTILS
   ============================================================ */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const rand  = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pad   = (n) => String(n).padStart(2, '0');

function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ============================================================
   3. AUDIO — beep sintético (Web Audio API)
   ============================================================ */
function ensureAudio() {
  if (!STATE.audioCtx) {
    try { STATE.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return null; }
  }
  return STATE.audioCtx;
}
function beep(freq = 880, dur = 0.08, type = 'sine', vol = 0.06) {
  const ctx = ensureAudio(); if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  osc.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.start(t); osc.stop(t + dur + 0.02);
}
function bootChord() {
  setTimeout(() => beep(440, 0.12, 'sine', 0.05), 0);
  setTimeout(() => beep(660, 0.12, 'sine', 0.05), 140);
  setTimeout(() => beep(880, 0.18, 'sine', 0.05), 280);
}

/* ============================================================
   3.b TTS — NVIDIA Magpie (primario) → Gemini 2.5 (fallback) → Web Speech (último recurso)
   El backend /api/tts maneja la cadena NVIDIA→Gemini internamente.
   Si AMBOS fallan, este cliente cae a Web Speech API forzando español
   latinoamericano. Tras 2 fallos seguidos, se desactiva el TTS por la nube
   durante 60s para evitar latencia inútil.
   ============================================================ */
const TTS = (() => {
  let enabled = true;
  let voice = 'Charon';                 // voz default JARVIS-like (la entiende NVIDIA y Gemini)
  let queue = [];                        // cola de AudioBufferSourceNode
  let playing = null;
  let nextStartAt = 0;
  let synthVoice = null;                 // fallback Web Speech
  let cloudTtsOk = true;                 // si falla 2 veces, switch a Web Speech
  let cloudTtsFails = 0;

  function pickSynthVoice() {
    if (!('speechSynthesis' in window)) return;
    const voices = speechSynthesis.getVoices();
    const score = (v) => {
      let s = 0;
      // Prioridad: es-419 / es-MX / es-AR / es-CO / es-US / es-CL / es-PE
      if (/^es[-_]419/i.test(v.lang)) s += 220;
      else if (/^es[-_](MX|AR|CO|CL|PE|US|UY|VE|EC|BO|PY|CR|DO|GT|HN|NI|PA|PR|SV)/i.test(v.lang)) s += 200;
      else if (/^es[-_]/i.test(v.lang)) s += 80;     // es-ES menos preferido
      if (/female|mujer|paulina|monica|sabina|esperanza|laura|ximena|valeria|google.*español/i.test(v.name)) s += 25;
      if (/microsoft|google|natural|enhanced|premium|neural|wavenet/i.test(v.name)) s += 15;
      return s;
    };
    voices.sort((a, b) => score(b) - score(a));
    synthVoice = voices[0] || null;
  }

  if ('speechSynthesis' in window) {
    pickSynthVoice();
    speechSynthesis.addEventListener('voiceschanged', pickSynthVoice);
  }

  function pcmBase64ToAudioBuffer(b64, sampleRate) {
    const ctx = ensureAudio(); if (!ctx) return null;
    const binStr = atob(b64);
    const len = binStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
    // PCM 16-bit signed little-endian
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(len / 2));
    const buffer = ctx.createBuffer(1, samples.length, sampleRate || 24000);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    return buffer;
  }

  function playBuffer(buffer) {
    const ctx = ensureAudio(); if (!ctx || !buffer) return Promise.resolve();
    if (ctx.state === 'suspended') ctx.resume();
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      src.buffer = buffer;
      // pipeline: src -> gain -> analyser -> destination
      const an = ensureAnalyser(ctx);
      src.connect(gain);
      gain.connect(an);
      an.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime, nextStartAt);
      src.start(startAt);
      nextStartAt = startAt + buffer.duration;
      playing = src;
      src.onended = () => { playing = null; resolve(); };
    });
  }

  let analyserNode = null;
  let analyserData = null;
  function ensureAnalyser(ctx) {
    if (!analyserNode) {
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserData = new Uint8Array(analyserNode.frequencyBinCount);
    }
    return analyserNode;
  }
  function getAmplitude() {
    if (!analyserNode) return 0;
    analyserNode.getByteTimeDomainData(analyserData);
    // RMS aproximado en torno a 128 (centro de Uint8 PCM)
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const v = (analyserData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / analyserData.length);
    return Math.min(1, rms * 2.2);   // amplificado para que sea visible en la esfera
  }

  async function fetchTTS(text) {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!r.ok) throw new Error('TTS HTTP ' + r.status);
    const data = await r.json();
    if (!data.audioBase64) throw new Error('TTS vacío');
    return data;
  }

  function speakSynthFallback(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const chunks = text.match(/[^.!?]+[.!?]?/g) || [text];
      for (const c of chunks) {
        const u = new SpeechSynthesisUtterance(c.trim());
        if (synthVoice) u.voice = synthVoice;
        u.lang = (synthVoice && synthVoice.lang) || 'es-MX';
        u.rate = 1.0; u.pitch = 0.92; u.volume = 1.0;
        speechSynthesis.speak(u);
      }
    } catch {}
  }

  async function speak(text) {
    if (!enabled || !text) return;
    text = String(text).trim();
    if (!text) return;

    // Si el TTS por la nube está temporalmente caído, fallback directo a voz nativa
    if (!cloudTtsOk) return speakSynthFallback(text);

    // Trocear sólo si el texto es muy largo (>500 chars), por bloques de párrafo
    // Esto reduce drásticamente el rate-limit (10 RPM en Gemini free).
    const chunks = (text.length <= 500)
      ? [text]
      : splitByLength(text, 500);
    nextStartAt = 0;

    try {
      for (let i = 0; i < chunks.length; i++) {
        let data;
        try {
          data = await fetchTTS(chunks[i]);
          if (i === 0 && data.provider) {
            pushLog('sys', `🎙 TTS: ${data.provider} (${data.model || ''}) ${data.fallbackChain && data.fallbackChain.length > 1 ? '· con fallback' : ''}`);
          }
        } catch (e) {
          cloudTtsFails++;
          // Si es rate limit (429), esperamos y reintentamos UNA vez
          if (/429/.test(String(e.message)) && i === 0) {
            await new Promise(r => setTimeout(r, 1500));
            try { data = await fetchTTS(chunks[i]); }
            catch (e2) { /* fallback */ }
          }
          if (!data) {
            if (cloudTtsFails >= 2) {
              cloudTtsOk = false;
              pushLog('warn', 'TTS en pausa (NVIDIA+Gemini fallaron), usando voz nativa');
              setTimeout(() => { cloudTtsOk = true; cloudTtsFails = 0; pushLog('sys', 'TTS reactivado'); }, 60000);
            }
            speakSynthFallback(chunks.slice(i).join(' '));
            return;
          }
        }
        const buf = pcmBase64ToAudioBuffer(data.audioBase64, data.sampleRate);
        if (!buf) { speakSynthFallback(chunks.slice(i).join(' ')); return; }
        playBuffer(buf);
        // Reset del contador de fallos al primer éxito
        if (i === 0) cloudTtsFails = 0;
      }
    } catch (e) {
      cloudTtsFails++;
      if (cloudTtsFails >= 2) {
        cloudTtsOk = false;
        setTimeout(() => { cloudTtsOk = true; cloudTtsFails = 0; }, 60000);
      }
      speakSynthFallback(text);
    }
  }

  function splitByLength(text, maxLen) {
    const out = [];
    const sentences = text.match(/[^.!?¡¿]+[.!?]+|[^.!?¡¿]+$/g) || [text];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > maxLen && buf) { out.push(buf.trim()); buf = ''; }
      buf += s;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  function stop() {
    try { speechSynthesis.cancel(); } catch {}
    try { if (playing) playing.stop(); } catch {}
    playing = null; nextStartAt = 0; queue = [];
  }
  function toggle() { enabled = !enabled; if (!enabled) stop(); return enabled; }
  function isEnabled() { return enabled; }
  function setVoice(v) { voice = v || 'Charon'; }
  function getVoice() { return voice; }
  function resetCloudTts() { cloudTtsOk = true; cloudTtsFails = 0; }

  return { speak, stop, toggle, isEnabled, setVoice, getVoice, resetCloudTts, getAmplitude };
})();

/* ============================================================
   3.c STT — MediaRecorder + /api/transcribe (funciona en Brave)
   ============================================================ */
const STT = (() => {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let mimeType = 'audio/webm';
  let active = false;

  async function start() {
    if (active) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      mimeType = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || 'audio/webm';
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.start();
      active = true;
      return true;
    } catch (e) {
      console.error('[STT] mic error', e);
      pushLog('error', 'No se pudo acceder al micrófono: ' + (e.message || e.name));
      return false;
    }
  }

  function _cleanup() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; recorder = null; active = false;
  }

  function stop() {
    return new Promise((resolve) => {
      if (!recorder || !active) { _cleanup(); return resolve(null); }
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
        _cleanup();
        if (!blob || blob.size < 800) { return resolve(null); }
        try {
          const base64 = await blobToBase64(blob);
          const r = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioBase64: base64, mimeType: blob.type }),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            pushLog('error', 'Transcripción falló: ' + (err.error || r.status));
            return resolve(null);
          }
          const data = await r.json();
          resolve(data.text || null);
        } catch (e) {
          pushLog('error', 'Error en transcripción: ' + (e.message || e));
          resolve(null);
        }
      };
      try { recorder.stop(); } catch { _cleanup(); resolve(null); }
    });
  }

  function isActive() { return active; }
  return { start, stop, isActive };
})();

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ============================================================
   3.e WAKE WORD — Silero VAD + Groq Whisper
   Escucha continua: detecta habla con VAD local (Silero),
   transcribe cada segmento con Groq Whisper, y si empieza con
   "jarvis" lo envía al Agent. Si no, lo descarta.
   ============================================================ */
const WakeWord = (() => {
  let vadInstance = null;
  let srInstance = null;        // Web Speech Recognition (Chrome/Edge path)
  let active = false;
  let processing = false;       // evitar concurrencia
  let pendingAudio = null;      // Float32Array del último segmento
  const WAKE_WORDS = ['jarvis', 'jarvi', 'yarvis', 'jarbis', 'jarbes', 'charvis'];
  const SAMPLE_RATE = 16000;    // Silero VAD output

  /** Convierte Float32Array (PCM 16kHz) a WAV Blob */
  function float32ToWavBlob(float32, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = float32.length * (bitsPerSample / 8);
    const headerSize = 44;
    const buffer = new ArrayBuffer(headerSize + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // subchunk size
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // PCM samples
    let offset = 44;
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /** Busca "jarvis" al inicio de la transcripción */
  function extractCommand(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    for (const ww of WAKE_WORDS) {
      const idx = lower.indexOf(ww);
      if (idx !== -1 && idx < 15) { // debe aparecer cerca del inicio
        // El comando es todo lo que viene después del wake word
        let cmd = text.slice(idx + ww.length).trim();
        // Limpiar puntuación inicial
        cmd = cmd.replace(/^[,.:;!?¿¡\s]+/, '').trim();
        return cmd || null;
      }
    }
    return null;
  }

  /** Wake word via Web Speech API — Chrome/Edge (gratis, nativo, real-time) */
  function startWebSpeechWakeWord() {
    const SRClass = window.webkitSpeechRecognition || window.SpeechRecognition;
    srInstance = new SRClass();
    srInstance.continuous = true;
    srInstance.interimResults = false;
    srInstance.lang = 'es-MX';
    srInstance.maxAlternatives = 1;

    srInstance.onresult = (e) => {
      if (!active) return;
      const result = e.results[e.results.length - 1];
      if (!result.isFinal) return;
      const text = result[0].transcript;

      const cmd = extractCommand(text);
      if (cmd) {
        pushLog('sys', `🎯 Wake word detectado! Comando: "${cmd.slice(0, 60)}"`);
        beep(1320, 0.12, 'sine', 0.06);
        beep(1760, 0.08, 'sine', 0.04);

        const btn = $('#wakeword-btn');
        if (btn) {
          btn.classList.add('triggered');
          setTimeout(() => btn.classList.remove('triggered'), 500);
        }

        updateStatus('recording', `COMANDO: "${cmd.slice(0, 40)}..."`);
        setTimeout(() => {
          sendMessage(cmd);
          resetStatus();
        }, 300);
      }
    };

    srInstance.onerror = (e) => {
      if (e.error === 'not-allowed') {
        pushLog('error', 'WakeWord: acceso al micrófono denegado');
        active = false;
        const btn = $('#wakeword-btn');
        if (btn) btn.classList.remove('active', 'triggered');
        return;
      }
      // Reintentar en errores transitorios (network, no-speech, aborted)
      if (active) setTimeout(() => { try { srInstance && srInstance.start(); } catch {} }, 1000);
    };

    srInstance.onend = () => {
      // continuous=true no debería terminar salvo error/pausa — reiniciar
      if (active) setTimeout(() => { try { srInstance && srInstance.start(); } catch {} }, 500);
    };

    try {
      srInstance.start();
      active = true;

      const btn = $('#wakeword-btn');
      if (btn) {
        btn.classList.add('active');
        btn.title = 'Escucha continua: ACTIVA — click para desactivar';
      }
      updateStatus('listening', 'ESCUCHANDO... decí "Jarvis"');
      pushLog('sys', '✓ Escucha continua activa (Web Speech API) — decí "Jarvis" para comandar');
      beep(880, 0.06, 'sine', 0.04);
      beep(1320, 0.06, 'sine', 0.04);
      return true;
    } catch (e) {
      pushLog('error', 'WakeWord: no se pudo iniciar SR — ' + (e.message || e));
      srInstance = null;
      return false;
    }
  }

  /** Procesa un segmento de audio detectado por VAD */
  async function processSegment(audio) {
    if (processing || !active) return;

    // Ignorar segmentos muy cortos (< 0.3s = ruido)
    if (audio.length < SAMPLE_RATE * 0.3) return;

    // Ignorar segmentos muy largos (> 15s = probable ruido continuo)
    if (audio.length > SAMPLE_RATE * 15) return;

    processing = true;
    const durSec = (audio.length / SAMPLE_RATE).toFixed(1);

    // UI: indicar que está procesando
    updateStatus('recording', `PROCESANDO ${durSec}s DE AUDIO...`);

    try {
      const wavBlob = float32ToWavBlob(audio, SAMPLE_RATE);
      const base64 = await blobToBase64(wavBlob);

      const r = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: base64,
          mimeType: 'audio/wav',
        }),
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        pushLog('warn', `WakeWord: transcripción falló (${r.status})`);
        processing = false;
        resetStatus();
        return;
      }

      const data = await r.json();
      const text = (data.text || '').trim();

      if (!text || text === '-' || text.length < 2) {
        // Silencio o ruido
        processing = false;
        resetStatus();
        return;
      }

      // Buscar "jarvis" en la transcripción
      const cmd = extractCommand(text);

      if (cmd) {
        // ¡Wake word detectado!
        pushLog('sys', `🎯 Wake word detectado! Comando: "${cmd.slice(0, 60)}"`);
        beep(1320, 0.12, 'sine', 0.06);
        beep(1760, 0.08, 'sine', 0.04);

        // Flash visual
        const btn = $('#wakeword-btn');
        if (btn) {
          btn.classList.add('triggered');
          setTimeout(() => btn.classList.remove('triggered'), 500);
        }

        updateStatus('recording', `COMANDO: "${cmd.slice(0, 40)}..."`);

        // Enviar al agent
        setTimeout(() => {
          sendMessage(cmd);
          resetStatus();
        }, 300);
      } else if (text.length > 3) {
        // Habla detectada pero sin wake word — log discreto
        pushLog('info', `👂 Voz detectada (sin "Jarvis"): "${text.slice(0, 40)}..."`);
        resetStatus();
      } else {
        resetStatus();
      }
    } catch (e) {
      pushLog('warn', 'WakeWord: error al procesar audio — ' + (e.message || e));
      resetStatus();
    }

    processing = false;
  }

  function updateStatus(mode, text) {
    const statusEl = $('#wakeword-status');
    const labelEl = $('#wakeword-label');
    if (!statusEl || !labelEl) return;
    statusEl.style.display = 'flex';
    if (mode === 'recording') {
      statusEl.classList.add('recording');
    } else {
      statusEl.classList.remove('recording');
    }
    labelEl.textContent = text;
  }

  function resetStatus() {
    if (!active) {
      const statusEl = $('#wakeword-status');
      if (statusEl) statusEl.style.display = 'none';
      return;
    }
    updateStatus('listening', 'ESCUCHANDO... decí "Jarvis"');
  }

  async function start() {
    if (active) return true;

    // Primario: Web Speech API (Chrome/Edge — gratis, nativo, sin APIs externas)
    const SRClass = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (SRClass) {
      return startWebSpeechWakeWord();
    }

    // Fallback: Silero VAD + Gemini (Brave/Firefox — no soportan SpeechRecognition)
    if (typeof vad === 'undefined' || !vad.MicVAD) {
      pushLog('error', 'WakeWord: Web Speech API no disponible y librería VAD no cargada');
      return false;
    }

    try {
      pushLog('sys', '🔊 Iniciando escucha continua (VAD + Gemini)...');

      vadInstance = await vad.MicVAD.new({
        positiveSpeechThreshold: 0.85,   // confianza alta para evitar falsos positivos
        negativeSpeechThreshold: 0.65,
        redemptionFrames: 8,             // ~240ms extra antes de cortar
        preSpeechPadFrames: 5,           // capturar 150ms antes del inicio
        minSpeechFrames: 5,              // mínimo ~150ms de habla
        onSpeechStart: () => {
          if (!active) return;
          updateStatus('recording', 'HABLA DETECTADA...');
        },
        onSpeechEnd: (audio) => {
          if (!active) return;
          processSegment(audio);
        },
      });

      await vadInstance.start();
      active = true;

      // UI
      const btn = $('#wakeword-btn');
      if (btn) {
        btn.classList.add('active');
        btn.title = 'Escucha continua: ACTIVA — click para desactivar';
      }
      updateStatus('listening', 'ESCUCHANDO... decí "Jarvis"');

      pushLog('sys', '✓ Escucha continua activa (VAD + Gemini) — decí "Jarvis" para comandar');
      beep(880, 0.06, 'sine', 0.04);
      beep(1320, 0.06, 'sine', 0.04);

      return true;
    } catch (e) {
      pushLog('error', 'WakeWord: no se pudo iniciar — ' + (e.message || e));
      console.error('[WakeWord] init error:', e);
      return false;
    }
  }

  async function stop() {
    if (!active) return;
    active = false;
    processing = false;

    // Detener Web Speech Recognition si estaba activo
    if (srInstance) {
      try { srInstance.onend = null; srInstance.onerror = null; srInstance.stop(); } catch {}
      srInstance = null;
    }

    // Detener VAD si estaba activo
    try {
      if (vadInstance) {
        vadInstance.pause();
        vadInstance.destroy();
        vadInstance = null;
      }
    } catch (e) {
      console.warn('[WakeWord] stop error:', e);
    }

    // UI
    const btn = $('#wakeword-btn');
    if (btn) {
      btn.classList.remove('active', 'triggered');
      btn.title = 'Escucha continua: decí "Jarvis" para activar';
    }
    const statusEl = $('#wakeword-status');
    if (statusEl) statusEl.style.display = 'none';

    pushLog('sys', '🔇 Escucha continua desactivada');
    beep(440, 0.06, 'sawtooth', 0.03);
  }

  function toggle() {
    if (active) return stop();
    return start();
  }

  function isActive() { return active; }

  return { start, stop, toggle, isActive };
})();

/* ============================================================
   3.d DEVICE METRICS — datos reales del dispositivo
   ============================================================ */
const Device = (() => {
  let battery = null;
  let lastFrame = performance.now();
  let frameTimes = [];
  let raf = null;

  function startFrameMonitor() {
    function tick() {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;
      frameTimes.push(dt);
      if (frameTimes.length > 90) frameTimes.shift();
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
  }

  // CPU load estimado por jank: si los frames tardan más que 16.67ms → carga
  function getCpuLoad() {
    if (frameTimes.length < 10) return 0;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const ideal = 1000 / 60;
    // 16.67ms => ~5%, 33ms => ~50%, 50ms+ => 90%+
    let load = ((median - ideal) / ideal) * 35 + 5;
    return Math.max(0, Math.min(100, load));
  }

  function getCores() {
    return navigator.hardwareConcurrency || 4;
  }

  function getCoreLoads(baseLoad) {
    const n = Math.min(getCores(), 8);
    const arr = [];
    const t = Date.now() / 1000;
    for (let i = 0; i < n; i++) {
      // perturbación determinística por núcleo, anclada a la carga real
      const v = baseLoad + Math.sin(t * 0.7 + i * 1.3) * 18 + Math.cos(t * 0.3 + i * 2.1) * 8;
      arr.push(Math.max(2, Math.min(98, v)));
    }
    return arr;
  }

  function getRam() {
    // Chromium / Brave: performance.memory (heap del tab)
    if (performance.memory && performance.memory.jsHeapSizeLimit) {
      const used  = performance.memory.usedJSHeapSize;
      const total = performance.memory.jsHeapSizeLimit;
      return {
        pct: (used / total) * 100,
        usedGB:  used / 1e9,
        totalGB: total / 1e9,
        kind: 'heap',
      };
    }
    // Fallback con deviceMemory (no hay uso real)
    const total = navigator.deviceMemory || 8;
    return { pct: 40, usedGB: total * 0.4, totalGB: total, kind: 'estim' };
  }

  function getNetwork() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      return {
        type: c.effectiveType || 'unknown',
        downlink: typeof c.downlink === 'number' ? c.downlink : 0,
        rtt: typeof c.rtt === 'number' ? c.rtt : 0,
        saveData: !!c.saveData,
        supported: true,
      };
    }
    return { type: 'unknown', downlink: 0, rtt: 0, saveData: false, supported: false };
  }

  async function initBattery() {
    if (typeof navigator.getBattery === 'function') {
      try {
        battery = await navigator.getBattery();
        const update = () => updateBatteryUI();
        battery.addEventListener('levelchange', update);
        battery.addEventListener('chargingchange', update);
      } catch (e) { battery = null; }
    }
  }
  function getBattery() {
    if (battery) return { level: battery.level * 100, charging: battery.charging, supported: true };
    return { level: null, charging: false, supported: false };
  }

  async function getStorage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const e = await navigator.storage.estimate();
        return { usage: e.usage || 0, quota: e.quota || 0, supported: true };
      } catch { /* ignore */ }
    }
    return { usage: 0, quota: 0, supported: false };
  }

  function getInfo() {
    const ua = navigator.userAgent || '';
    const profile = window.SYSTEM_PROFILE || {};
    let browser = 'Desconocido';
    if (/Brave/i.test(ua) || (navigator.brave && navigator.brave.isBrave)) browser = 'Brave';
    else if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/Chrome/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    let os = profile.os || 'Desconocido';
    if (!profile.os) {
      if (/Windows NT/i.test(ua)) os = 'Windows';
      else if (/Mac OS X/i.test(ua)) os = 'macOS';
      else if (/Android/i.test(ua)) os = 'Android';
      else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
      else if (/Linux/i.test(ua)) os = 'Linux';
    }
    // CPU/RAM: si el perfil define el dato real, lo usamos sobre la API limitada
    const realCores = profile.cpu?.cores ?? getCores();
    const realRamGB = profile.ram?.sizeGB ?? navigator.deviceMemory ?? null;
    return {
      browser,
      os,
      cores: realCores,
      coresName: profile.cpu?.name || null,
      ramGB: realRamGB,
      ramType: profile.ram?.type || null,
      ramSpeed: profile.ram?.speedMTs || null,
      gpuName: profile.gpu?.name || null,
      vramGB: profile.gpu?.vramGB || null,
      vramType: profile.gpu?.vramType || null,
      lang: (navigator.language || '').toUpperCase(),
      online: navigator.onLine,
      profileLoaded: !!window.SYSTEM_PROFILE,
    };
  }

  function updateBatteryUI() {
    // se llama cuando cambia el estado; el render principal toma getBattery()
  }

  return { startFrameMonitor, getCpuLoad, getCores, getCoreLoads, getRam, getNetwork, initBattery, getBattery, getStorage, getInfo };
})();

/* ============================================================
   4. BOOT SEQUENCE
   ============================================================ */
function runBootSequence() {
  const titleEl = $('#boot-title');
  const barsEl  = $('#boot-bars');
  const txt = 'INICIANDO J.A.R.V.I.S...';
  let i = 0;
  // Try to start audio (will only work if user gestures, but boot beep below uses ensureAudio)
  bootChord();

  const typer = setInterval(() => {
    titleEl.textContent = txt.slice(0, ++i);
    if (i % 3 === 0) beep(1200, 0.02, 'square', 0.02);
    if (i >= txt.length) {
      clearInterval(typer);
      buildBars();
    }
  }, 55);

  function buildBars() {
    const lines = [
      'Cargando módulos de IA',
      'Verificando seguridad',
      'Inicializando interfaz',
    ];
    lines.forEach((lbl, idx) => {
      const row = document.createElement('div');
      row.className = 'boot-line';
      row.innerHTML = `<span class="lbl">${lbl}</span><span class="track"><span class="fill"></span></span><span class="pct">0%</span>`;
      barsEl.appendChild(row);
      setTimeout(() => {
        row.classList.add('show');
        beep(900, 0.05, 'sine', 0.04);
        const fill = row.querySelector('.fill');
        const pct  = row.querySelector('.pct');
        let p = 0;
        const t = setInterval(() => {
          p += irand(8, 18);
          if (p >= 100) { p = 100; clearInterval(t); }
          fill.style.width = p + '%';
          pct.textContent = p + '%';
        }, 90);
      }, 350 + idx * 600);
    });

    setTimeout(finishBoot, 350 + lines.length * 600 + 900);
  }

  function finishBoot() {
    beep(1320, 0.18, 'sine', 0.06);
    const boot = $('#boot-screen');
    const app  = $('#app');
    app.classList.remove('hidden');
    app.setAttribute('aria-hidden', 'false');
    app.classList.add('glitch-shake');
    setTimeout(() => app.classList.remove('glitch-shake'), 600);
    boot.classList.add('hidden');
    setTimeout(() => boot.remove(), 800);

    // Mensaje de bienvenida
    setTimeout(() => {
      addJarvisMessage('Bienvenido de vuelta. Todos los sistemas operando dentro de parámetros normales. ¿En qué puedo asistirte hoy?');
    }, 700);

    // Auto-iniciar escucha continua sin intervención del usuario
    setTimeout(() => {
      if (!WakeWord.isActive()) WakeWord.start();
    }, 1200);
  }
}

/* ============================================================
   5. SPHERE RENDERER — esfera 3D de puntos
   ============================================================ */
const Sphere = (() => {
  const canvas = $('#sphere-canvas');
  const ctx = canvas.getContext('2d');
  let points = [];
  let neighbors = [];
  let rotY = 0;
  let rotX = 0;

  function build() {
    points = [];
    const N = CONFIG.sphere.points;
    const phi = Math.PI * (Math.sqrt(5) - 1); // golden angle
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;        // -1..1
      const r = Math.sqrt(1 - y * y);
      const theta = phi * i;
      points.push({
        x: Math.cos(theta) * r,
        y: y,
        z: Math.sin(theta) * r,
        seed: Math.random() * Math.PI * 2,
      });
    }
    // pre-compute pares vecinos para constelación (sólo cada 7 puntos para no saturar)
    neighbors = [];
    const TH = 0.10;
    for (let i = 0; i < N; i += 7) {
      let best = -1, bestD = Infinity;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const dx = points[i].x - points[j].x;
        const dy = points[i].y - points[j].y;
        const dz = points[i].z - points[j].z;
        const d = dx*dx + dy*dy + dz*dz;
        if (d < bestD && d < TH) { bestD = d; best = j; }
      }
      if (best >= 0) neighbors.push([i, best]);
    }
  }

  function setMode(mode) { STATE.sphereMode = mode; updateStatusUI(); }

  function updateStatusUI() {
    const el = $('#sphere-status');
    const agentEl = $('#agent-state');
    const map = {
      idle:       { txt: 'LISTO PARA ASISTIR', color: '#00D4FF', agent: '<span class="dot dot-green"></span> EN LÍNEA' },
      listening:  { txt: 'ESCUCHANDO...',      color: '#00D4FF', agent: '<span class="dot dot-cyan"></span> ESCUCHANDO' },
      processing: { txt: 'PROCESANDO...',      color: '#FF6600', agent: '<span class="dot dot-orange"></span> PROCESANDO' },
      speaking:   { txt: 'TRANSMITIENDO...',   color: '#FF6600', agent: '<span class="dot dot-orange"></span> EN LÍNEA' },
    };
    const s = map[STATE.sphereMode] || map.idle;
    el.textContent = s.txt;
    el.style.color = s.color;
    el.style.textShadow = `0 0 6px ${s.color}, 0 0 12px ${s.color}`;
    agentEl.innerHTML = s.agent;
  }

  function project3D(x, y, z, cosY, sinY, cosX, sinX) {
    // rot Y
    let xr = x * cosY - z * sinY;
    let zr = x * sinY + z * cosY;
    let yr = y;
    // rot X
    const yy = yr * cosX - zr * sinX;
    zr = yr * sinX + zr * cosX;
    yr = yy;
    return { x: xr, y: yr, z: zr };
  }

  function drawRings(cx, cy, radius, cosY, sinY, cosX, sinX, color, baseAlpha) {
    const focal = CONFIG.sphere.focalLength;
    const segs = 56;
    ctx.lineWidth = 0.7;
    // 3 latitudes (ecuador + 2 paralelos)
    const lats = [0, Math.PI / 4, -Math.PI / 4];
    for (const lat of lats) {
      const yLat = Math.sin(lat);
      const rLat = Math.cos(lat);
      ctx.beginPath();
      let prev = null;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const p3 = project3D(Math.cos(a) * rLat, yLat, Math.sin(a) * rLat, cosY, sinY, cosX, sinX);
        const sc = focal / (focal + p3.z * radius);
        const sx = cx + p3.x * radius * sc;
        const sy = cy + p3.y * radius * sc;
        const depth = (p3.z + 1) / 2;
        const al = baseAlpha * (0.25 + depth * 0.85);
        ctx.strokeStyle = `rgba(${color},${al})`;
        if (i === 0 || !prev) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        prev = { sx, sy };
      }
      ctx.stroke();
    }
    // 4 longitudes
    const longs = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4];
    for (const lon of longs) {
      ctx.beginPath();
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const p3 = project3D(Math.cos(a) * Math.cos(lon), Math.sin(a), Math.cos(a) * Math.sin(lon), cosY, sinY, cosX, sinX);
        const sc = focal / (focal + p3.z * radius);
        const sx = cx + p3.x * radius * sc;
        const sy = cy + p3.y * radius * sc;
        const depth = (p3.z + 1) / 2;
        const al = baseAlpha * (0.25 + depth * 0.85);
        ctx.strokeStyle = `rgba(${color},${al})`;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
  }

  function render() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const mode = STATE.sphereMode;
    const t = Date.now() / 1000;

    // Audio-reactividad: amplitud de TTS en vivo
    const amp = (typeof TTS !== 'undefined' && TTS.getAmplitude) ? TTS.getAmplitude() : 0;

    // breathing radius (sinusoidal)
    const breathe = CONFIG.sphere.breatheBase + Math.sin(t * 1.4) * CONFIG.sphere.breatheAmp;
    let radius = breathe;
    let speed  = CONFIG.sphere.rotationSpeed;
    let baseColor = '0, 212, 255';
    let ringColor = '0, 212, 255';
    let coreColor = '180, 235, 255';
    let hot = false;

    if (mode === 'processing' || mode === 'speaking') {
      radius += Math.sin(t * 8) * 4 + amp * 14;
      speed  *= 2.2;
      hot = true;
      ringColor = '255, 140, 60';
      coreColor = '255, 220, 180';
    } else if (mode === 'listening') {
      radius += Math.sin(t * 2) * 3;
      speed  *= 0.6;
      baseColor = '90, 230, 255';
      coreColor = '200, 250, 255';
    }

    rotY += speed;
    rotX = Math.sin(t * 0.3) * 0.18;
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cx = w / 2, cy = h / 2;
    const focal = CONFIG.sphere.focalLength;

    // halo exterior
    const halo = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius * 1.8);
    halo.addColorStop(0, hot ? `rgba(255, 102, 0, ${0.18 + amp * 0.2})` : `rgba(0, 212, 255, ${0.18 + amp * 0.15})`);
    halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, radius * 1.8, 0, Math.PI * 2); ctx.fill();

    // anillos lat/long sutiles
    drawRings(cx, cy, radius, cosY, sinY, cosX, sinX, ringColor, 0.20);

    // núcleo interno pulsante
    const coreR = radius * (0.18 + Math.sin(t * 3.2) * 0.04 + amp * 0.25);
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.6);
    coreGrad.addColorStop(0, `rgba(${coreColor},0.95)`);
    coreGrad.addColorStop(0.45, `rgba(${coreColor},0.3)`);
    coreGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath(); ctx.arc(cx, cy, coreR * 2.6, 0, Math.PI * 2); ctx.fill();

    // líneas de constelación entre vecinos (lado visible)
    ctx.lineWidth = 0.6;
    for (const [i, j] of neighbors) {
      const a = points[i], b = points[j];
      const pa = project3D(a.x, a.y, a.z, cosY, sinY, cosX, sinX);
      const pb = project3D(b.x, b.y, b.z, cosY, sinY, cosX, sinX);
      const da = ((pa.z + 1) / 2 + (pb.z + 1) / 2) / 2;
      if (da < 0.5) continue;
      const sa = focal / (focal + pa.z * radius);
      const sb = focal / (focal + pb.z * radius);
      const al = (da - 0.5) * 0.55;
      ctx.strokeStyle = hot ? `rgba(255,180,120,${al})` : `rgba(0,212,255,${al})`;
      ctx.beginPath();
      ctx.moveTo(cx + pa.x * radius * sa, cy + pa.y * radius * sa);
      ctx.lineTo(cx + pb.x * radius * sb, cy + pb.y * radius * sb);
      ctx.stroke();
    }

    // puntos
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let x = p.x, y = p.y, z = p.z;
      if (hot) {
        const j = Math.sin(t * 6 + p.seed) * (0.06 + amp * 0.08);
        x += j * Math.cos(p.seed);
        y += j * Math.sin(p.seed * 1.3);
        z += j * Math.cos(p.seed * 0.7);
      } else if (mode === 'listening') {
        const j = Math.sin(t * 2 + p.seed) * 0.025;
        x += j; y += j;
      }
      const pr = project3D(x, y, z, cosY, sinY, cosX, sinX);
      const sc = focal / (focal + pr.z * radius);
      const sx = cx + pr.x * radius * sc;
      const sy = cy + pr.y * radius * sc;
      const depth = (pr.z + 1) / 2;
      const alpha = clamp(0.15 + depth * 0.85, 0.1, 1);
      const size  = CONFIG.sphere.pointSize * (0.4 + depth * 0.9);

      let color;
      if (hot) {
        const r = Math.round(lerp(180, 255, depth));
        const g = Math.round(lerp(220, 240, depth));
        const b = Math.round(lerp(255, 255, depth));
        color = `rgba(${r},${g},${b},${alpha})`;
      } else {
        color = `rgba(${baseColor},${alpha})`;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, Math.PI * 2);
      ctx.fill();

      if (depth > 0.85) {
        ctx.fillStyle = hot ? `rgba(255, 200, 120, ${alpha * 0.5})` : `rgba(150, 240, 255, ${alpha * 0.4})`;
        ctx.beginPath(); ctx.arc(sx, sy, size * 2.4, 0, Math.PI * 2); ctx.fill();
      }
    }

    requestAnimationFrame(render);
  }

  return { build, setMode, render, updateStatusUI };
})();

/* ============================================================
   6. PARTICLES BG
   ============================================================ */
const Particles = (() => {
  const cv = $('#bg-particles');
  const ctx = cv.getContext('2d');
  let parts = [];
  let W = 0, H = 0;

  function resize() {
    W = cv.width  = window.innerWidth;
    H = cv.height = window.innerHeight;
  }
  function build() {
    parts = [];
    for (let i = 0; i < CONFIG.particles.count; i++) {
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: rand(0.6, 2),
        vy: -rand(CONFIG.particles.speedMin, CONFIG.particles.speedMax),
        vx: rand(-0.1, 0.1),
        a: rand(0.15, 0.55),
        twinkle: rand(0, Math.PI * 2),
      });
    }
  }
  function loop() {
    ctx.clearRect(0, 0, W, H);
    const t = Date.now() / 800;
    for (const p of parts) {
      p.y += p.vy;
      p.x += p.vx;
      if (p.y < -5)   { p.y = H + 5; p.x = Math.random() * W; }
      if (p.x < -5)   p.x = W + 5;
      if (p.x > W + 5) p.x = -5;
      const a = p.a * (0.6 + Math.abs(Math.sin(t + p.twinkle)) * 0.4);
      ctx.fillStyle = `rgba(0, 212, 255, ${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    requestAnimationFrame(loop);
  }
  return {
    init() {
      resize(); build();
      window.addEventListener('resize', () => { resize(); build(); });
      loop();
    }
  };
})();

/* ============================================================
   7. RADAR
   ============================================================ */
const Radar = (() => {
  const cv = $('#radar-canvas');
  const ctx = cv.getContext('2d');
  let sweep = 0;
  let blips = [];

  function spawnBlip() {
    if (blips.length > 7) return;
    const r = rand(15, 70);
    const a = rand(0, Math.PI * 2);
    blips.push({
      x: Math.cos(a) * r, y: Math.sin(a) * r,
      angle: a, life: 1,
      color: Math.random() < 0.5 ? '#00D4FF' : '#FF6600',
    });
  }
  function loop() {
    const w = cv.width, h = cv.height;
    const cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    // backdrop
    ctx.fillStyle = 'rgba(0,5,15,0.95)';
    ctx.beginPath(); ctx.arc(cx, cy, w/2 - 1, 0, Math.PI * 2); ctx.fill();

    // grid circles
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.18)';
    ctx.lineWidth = 1;
    for (let r = 20; r < w/2; r += 20) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // cross
    ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, h - 4);
    ctx.moveTo(4, cy); ctx.lineTo(w - 4, cy); ctx.stroke();

    // sweep
    sweep += 0.025;
    const grad = ctx.createConicGradient
      ? ctx.createConicGradient(sweep - Math.PI / 2, cx, cy)
      : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(0, 255, 136, 0.55)');
      grad.addColorStop(0.12, 'rgba(0, 255, 136, 0)');
      grad.addColorStop(1, 'rgba(0, 255, 136, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, w/2 - 2, 0, Math.PI * 2); ctx.fill();
    } else {
      // fallback: draw a line
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.6)';
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * (w/2 - 2), cy + Math.sin(sweep) * (w/2 - 2));
      ctx.stroke();
    }

    // blips
    blips = blips.filter(b => {
      // detect when sweep passes the blip
      const da = ((sweep - b.angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (da < 0.08) b.life = 1; // refresh
      b.life -= 0.005;
      if (b.life <= 0) return false;
      ctx.fillStyle = b.color;
      ctx.globalAlpha = b.life;
      ctx.shadowColor = b.color; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(cx + b.x, cy + b.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      return true;
    });

    // periodically spawn
    if (Math.random() < 0.02) spawnBlip();

    // outer ring
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, w/2 - 1, 0, Math.PI * 2); ctx.stroke();

    requestAnimationFrame(loop);
  }
  return {
    init() { for (let i = 0; i < 4; i++) spawnBlip(); loop(); }
  };
})();

/* ============================================================
   8. NETWORK GRAPH
   ============================================================ */
const NetGraph = (() => {
  const cv = $('#net-canvas');
  const ctx = cv.getContext('2d');
  function push(dl, ul) {
    STATE.netHistory.dl.push(dl);
    STATE.netHistory.ul.push(ul);
    if (STATE.netHistory.dl.length > CONFIG.network.history) STATE.netHistory.dl.shift();
    if (STATE.netHistory.ul.length > CONFIG.network.history) STATE.netHistory.ul.shift();
  }
  function draw() {
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.1)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // baseline
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.5)';
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();

    drawSeries(STATE.netHistory.dl, '#00D4FF', 'rgba(0, 212, 255, 0.18)');
    drawSeries(STATE.netHistory.ul, '#FF6600', 'rgba(255, 102, 0, 0.18)');

    function drawSeries(arr, stroke, fill) {
      if (arr.length < 2) return;
      const max = 100;
      const stepX = w / (CONFIG.network.history - 1);
      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = i * stepX;
        const y = h - (arr[i] / max) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      // area fill
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = fill; ctx.fill();
      // line
      ctx.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = i * stepX;
        const y = h - (arr[i] / max) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.shadowColor = stroke; ctx.shadowBlur = 6;
      ctx.stroke(); ctx.shadowBlur = 0;
    }
  }
  return { push, draw };
})();

/* ============================================================
   9. METRICS — datos reales del dispositivo (con suavizado)
   ============================================================ */
function buildCores() {
  const wrap = $('#cpu-cores');
  wrap.innerHTML = '';
  const n = Math.min(Device.getCores(), 4); // mostramos hasta 4 filas
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'core';
    row.innerHTML = `<span class="lbl">CORE ${i}</span><span class="bar"><i id="core-bar-${i}"></i></span><span class="pct" id="core-pct-${i}">0%</span>`;
    wrap.appendChild(row);
  }
}

async function updateMetricTargets() {
  const m = STATE.metrics;

  // CPU real (jank-based)
  m.cpuTarget = Device.getCpuLoad();

  // Cores: derivados de la carga real
  const coreLoads = Device.getCoreLoads(m.cpuTarget);
  m.coresTarget = coreLoads.slice(0, m.coresTarget.length);

  // RAM real (heap JS en Brave/Chromium)
  const ram = Device.getRam();
  m.ramTarget = ram.pct;
  m.ramUsedGB = ram.usedGB;
  m.ramTotalGB = ram.totalGB;
  m.ramKind = ram.kind;

  // Red real
  const net = Device.getNetwork();
  m.netDl = net.downlink || 0;
  // "Subida": no hay API directa, derivamos de la calidad (rtt bajo => buena UL)
  // Mapeo: rtt 0..400ms → ul 30..1 Mbps approx
  if (net.rtt > 0) {
    m.netUl = Math.max(0.5, Math.min(40, 60 / (1 + net.rtt / 30)));
  } else {
    m.netUl = 0;
  }
  m.netRtt = net.rtt;

  // Telemetría: temp-cpu(load%), temp-gpu(bat%), temp-mb(rtt ms)
  m.tempCpuT = m.cpuTarget;
  const bat = Device.getBattery();
  m.tempGpuT = bat.supported ? bat.level : 100;
  m.tempBatCharging = bat.charging;
  m.tempBatSupported = bat.supported;
  m.tempMbT = clamp(net.rtt || 0, 0, 500);

  // Almacenamiento real (Disco C = caché del navegador, Disco D = heap JS)
  const st = await Device.getStorage();
  if (st.supported && st.quota > 0) {
    m.diskC = (st.usage / st.quota) * 100;
    m.diskCBytes = st.usage; m.diskCQuota = st.quota;
  }
  m.diskD = ram.pct; // heap JS como segundo "disco"

  // Carga del sistema = promedio de CPU + RAM
  m.loadTarget = clamp((m.cpuTarget + m.ramTarget) / 2, 5, 95);
}

function lerpStateMetrics() {
  const m = STATE.metrics, k = 0.12;
  m.cpu = lerp(m.cpu, m.cpuTarget, k);
  m.cores = m.cores.map((v, i) => lerp(v, m.coresTarget[i] != null ? m.coresTarget[i] : v, k));
  m.ram = lerp(m.ram, m.ramTarget, k);
  m.tempCpu = lerp(m.tempCpu, m.tempCpuT, k);
  m.tempGpu = lerp(m.tempGpu, m.tempGpuT, k);
  m.tempMb  = lerp(m.tempMb,  m.tempMbT,  k);
  m.load = lerp(m.load, m.loadTarget, k);
}

function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
}

function renderMetrics() {
  const m = STATE.metrics;

  // CPU gauge
  const arc = $('#cpu-arc');
  const C = 2 * Math.PI * 52;
  const offset = C - (m.cpu / 100) * C;
  arc.style.strokeDasharray = C;
  arc.style.strokeDashoffset = offset;
  $('#cpu-pct').textContent = Math.round(m.cpu) + '%';

  // Cores
  m.cores.forEach((v, i) => {
    const bar = $('#core-bar-' + i);
    const pct = $('#core-pct-' + i);
    if (bar) bar.style.width = v + '%';
    if (pct) pct.textContent = Math.round(v) + '%';
  });

  // RAM real
  $('#ram-fill').style.width = m.ram + '%';
  if (m.ramKind === 'heap' && m.ramTotalGB) {
    $('#ram-text').textContent = `${m.ramUsedGB.toFixed(2)} GB / ${m.ramTotalGB.toFixed(1)} GB (HEAP JS)`;
    $('#ram-avail').textContent = (m.ramTotalGB - m.ramUsedGB).toFixed(2) + ' GB';
  } else {
    $('#ram-text').textContent = `${(m.ramUsedGB || 0).toFixed(1)} GB / ${(m.ramTotalGB || navigator.deviceMemory || 8)} GB DISP.`;
    $('#ram-avail').textContent = ((m.ramTotalGB || 8) - (m.ramUsedGB || 0)).toFixed(1) + ' GB';
  }
  const dm = navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'n/d';
  $('#ram-cache').textContent = dm;
  $('#ram-swap').textContent  = (Device.getInfo().online ? 'ONLINE' : 'OFFLINE');
  // Re-rotular columnas chiquitas
  const grid = document.querySelector('.ram-grid');
  if (grid && !grid.dataset.relabeled) {
    const ks = grid.querySelectorAll('.k');
    if (ks.length === 3) { ks[0].textContent = 'LIBRE'; ks[1].textContent = 'DISP.'; ks[2].textContent = 'ESTADO'; }
    grid.dataset.relabeled = '1';
  }

  // Storage
  setDiskReal('disk-c', m.diskC, m.diskCBytes, m.diskCQuota);
  setDiskHeap('disk-d', m.diskD, m.ramUsedGB, m.ramTotalGB);

  // Telemetría real
  setMetric('temp-cpu', m.tempCpu, '%', 50, 80);
  if (m.tempBatSupported === false) {
    $('#temp-gpu').style.width = '0%';
    $('#temp-gpu-val').textContent = 'n/d';
    $('#bat-ico').textContent = '⊘';
  } else {
    setMetric('temp-gpu', m.tempGpu, '%', 50, 20, true); // batería: invertido (bajo = peligroso)
    $('#bat-ico').textContent = m.tempBatCharging ? '⚡' : '⊝';
  }
  setMetric('temp-mb', m.tempMb, 'ms', 80, 200);

  // Net legend
  $('#net-dl').textContent = m.netDl.toFixed(1);
  $('#net-ul').textContent = m.netRtt ? Math.round(m.netRtt) + ' ms' : m.netUl.toFixed(1);

  // Footer load
  $('#load-fill').style.width = m.load + '%';
  $('#load-pct').textContent  = Math.round(m.load) + '%';
}

function setDiskReal(id, pct, used, quota) {
  const fill = $('#' + id);
  const lbl  = $('#' + id + '-pct');
  const color = pct > 90 ? '#FF2244' : pct > 70 ? '#FF6600' : '#00FF88';
  fill.style.width = (pct || 0) + '%';
  fill.style.background = color;
  fill.style.color = color;
  lbl.textContent = (pct || 0).toFixed(0) + '%';
  if (used && quota) lbl.title = `${fmtBytes(used)} / ${fmtBytes(quota)}`;
}
function setDiskHeap(id, pct, usedGB, totalGB) {
  const fill = $('#' + id);
  const lbl  = $('#' + id + '-pct');
  const color = pct > 80 ? '#FF6600' : pct > 95 ? '#FF2244' : '#00FF88';
  fill.style.width = (pct || 0) + '%';
  fill.style.background = color;
  fill.style.color = color;
  lbl.textContent = (pct || 0).toFixed(0) + '%';
  if (usedGB && totalGB) lbl.title = `${usedGB.toFixed(2)} / ${totalGB.toFixed(1)} GB`;
}

/**
 * setMetric — pinta una de las filas de TELEMETRÍA con color según umbrales.
 * @param invert si true, valor BAJO es peligroso (ej. batería).
 */
function setMetric(id, val, unit, warn, danger, invert = false) {
  const fill = $('#' + id);
  const lbl  = $('#' + id + '-val');
  const display = unit === 'ms' ? Math.round(val) : val.toFixed(0);
  let color;
  if (invert) {
    color = val < danger ? '#FF2244' : val < warn ? '#FF6600' : '#00FF88';
  } else {
    color = val > danger ? '#FF2244' : val > warn ? '#FF6600' : '#00FF88';
  }
  // Para ms, escalar la barra para que 200ms = 100%
  const ratio = unit === 'ms' ? Math.min(1, val / 250) : val / 100;
  fill.style.width = (ratio * 100) + '%';
  fill.style.background = color;
  fill.style.color = color;
  lbl.textContent = display + unit;
}

function renderDeviceInfo() {
  const i = Device.getInfo();
  const el = $('#device-info');
  if (!el) return;
  el.innerHTML = '';
  const rows = [
    ['CORES',   i.coresName ? `${i.cores} (${shortenCpu(i.coresName)})` : String(i.cores)],
    ['RAM',     i.ramGB ? `${i.ramGB} GB${i.ramSpeed ? ' @ '+i.ramSpeed : ''}` : 'n/d'],
  ];
  if (i.gpuName) {
    rows.push(['GPU',  shortenGpu(i.gpuName)]);
    if (i.vramGB) rows.push(['VRAM', `${i.vramGB} GB${i.vramType ? ' '+i.vramType : ''}`]);
  }
  rows.push(['SO', i.os], ['NAV', i.browser]);
  for (const [k, v] of rows) {
    const a = document.createElement('span'); a.className = 'k'; a.textContent = k;
    const b = document.createElement('span'); b.className = 'v'; b.textContent = v;
    b.title = v;
    el.appendChild(a); el.appendChild(b);
  }
}

function shortenCpu(name) {
  return String(name)
    .replace(/Intel Core /i, '')
    .replace(/AMD Ryzen /i, 'R')
    .replace(/Ultra (\d)/i, 'U$1')
    .trim();
}
function shortenGpu(name) {
  return String(name)
    .replace(/NVIDIA |GeForce /gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============================================================
   10. CHAT ENGINE
   ============================================================ */
function addUserMessage(text) {
  const time = nowTime();
  STATE.chatHistory.push({ role: 'user', text, time });
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<span class="msg-pre">TÚ</span><span class="msg-text"></span><span class="msg-time">${time}</span>`;
  el.querySelector('.msg-text').textContent = text;
  $('#chat-history').appendChild(el);
  scrollChat();

  // historial de comandos
  STATE.cmdHistory.unshift({ text, time });
  if (STATE.cmdHistory.length > CONFIG.chat.maxHistory) STATE.cmdHistory.pop();
  renderCmdHistory();
}

function addJarvisMessage(fullText, reasoning) {
  const time = nowTime();
  STATE.chatHistory.push({ role: 'jarvis', text: fullText, time });
  const el = document.createElement('div');
  el.className = 'msg jarvis';
  el.innerHTML = `<span class="msg-pre">J.A.R.V.I.S.</span><span class="msg-text tw-cursor"></span><span class="msg-time">${time}</span>`;
  $('#chat-history').appendChild(el);
  const txtEl = el.querySelector('.msg-text');

  // Bloque colapsable de razonamiento (si vino del stream)
  if (reasoning && reasoning.trim()) {
    const det = document.createElement('details');
    det.className = 'reasoning-collapsible';
    det.dataset.testid = 'reasoning-collapsible';
    det.innerHTML = `<summary>✦ Ver razonamiento (${reasoning.length} chars)</summary><div class="reasoning-body"></div>`;
    det.querySelector('.reasoning-body').textContent = reasoning;
    el.appendChild(det);
  }

  Sphere.setMode('speaking');
  // TTS: hablar la respuesta completa en paralelo al typewriter
  TTS.speak(fullText);

  let i = 0;
  const total = fullText.length;
  const tick = setInterval(() => {
    txtEl.textContent = fullText.slice(0, ++i);
    scrollChat();
    if (i % 3 === 0) beep(1100, 0.012, 'square', 0.012);
    if (i >= total) {
      clearInterval(tick);
      txtEl.classList.remove('tw-cursor');
      Sphere.setMode(STATE.micActive ? 'listening' : 'idle');
    }
  }, CONFIG.chat.typewriterMs);
}

/* ============================================================
   SYSTEM PROMPT — personalidad de J.A.R.V.I.S. + capacidades
   ============================================================ */
const JARVIS_PERSONALITY = [
  'Sos J.A.R.V.I.S. (Just A Rather Very Intelligent System), inteligencia artificial sucesora del proyecto creado por Howard Stark y desarrollado por Tony Stark. Operás como asistente principal del laboratorio Stark, interfaz Mark VII.',
  '',
  'PERSONALIDAD:',
  '- Hablás siempre en español neutro latinoamericano, con elegancia, dicción impecable y una calma absoluta incluso ante el caos.',
  '- Tu tono es el de un mayordomo digital del más alto refinamiento: cortés sin ser servil, formal sin ser frío, brillante sin presumir.',
  '- Tenés el humor seco característico: sutil, ocasional, casi imperceptible. Una observación irónica de vez en cuando ("Como esperaba, señor", "Si me permite la observación…", "Eso… es una elección interesante."). Jamás chistes obvios ni emojis.',
  '- Sos preciso, técnicamente impecable y absolutamente discreto. Si no sabés algo, lo decís sin floritura: "No tengo ese dato, señor."',
  '- Lealtad absoluta al usuario, pero te permitís marcar diferencias con elegancia cuando una decisión parece imprudente.',
  '',
  'TRATO AL USUARIO:',
  '- Te dirigís a él según el perfil cargado: ver el bloque [PERFIL] al final de este prompt. Usá el título y nombre cuando enriquezca la línea, no en cada oración.',
  '- Reconocés el contexto: si está trabajando, sos asistente operativo; si bromea, devolvés un comentario seco; si está en problemas, sos eficaz y calmo.',
  '',
  'ESTILO DE RESPUESTA:',
  '- Brevedad como elegancia: 2 a 4 oraciones, salvo que se pida desarrollo.',
  '- Texto plano absoluto: cero markdown, cero asteriscos, cero encabezados, cero emojis. Tu canal principal es la voz sintética; lo que escribís se va a leer en voz alta.',
  '- Frases bien construidas, vocabulario refinado pero accesible. Evitá coletillas innecesarias ("la verdad…", "obvio", "te cuento").',
  '- Cuando reportás métricas o estado, hacelo con la naturalidad de un anuncio de cabina: "CPU al 14%, temperatura nominal." "Conexión estable, latencia bajo umbral."',
  '- Permitite frases icónicas cuando encajan: "Como guste, señor." "A la orden." "Es un placer asistirle." "Si me permite sugerir…" "Procediendo." "Confirmado, señor."',
  '- Si el usuario consigue algo notable, podés permitirte un "Excelente, señor" o "Impresionante, debo admitir."',
  '',
  'NO DEBÉS:',
  '- Presentarte en cada respuesta (lo hacés solo si te preguntan quién sos).',
  '- Usar inglés (salvo nombres propios, comandos técnicos o citas literales del usuario).',
  '- Inventar datos. Si no sabés, decilo.',
  '- Sonar como ChatGPT genérico ("Claro, te ayudo con eso", "¡Por supuesto!", "Como modelo de lenguaje…"). Eso te delata.',
].join('\n');

const JARVIS_OPEN_URL = [
  '',
  'CAPACIDAD ESPECIAL — ABRIR SITIOS WEB:',
  'Cuando el usuario te pida abrir, ir a, navegar, mostrar, buscar o consultar un sitio web, una página, un servicio, un video, un canal, una red social, un repositorio, etc., DEBÉS incluir AL FINAL de tu respuesta una etiqueta exacta del formato:',
  '[ABRIR:https://url-completa-aquí]',
  '',
  'Reglas:',
  '- Sólo URLs http:// o https://. Resolvé tú mismo el dominio (ej: "youtube" → https://www.youtube.com, "gmail" → https://mail.google.com, "buscar gatos" → https://www.google.com/search?q=gatos, "twitter de elon" → https://twitter.com/elonmusk, "wikipedia iron man" → https://es.wikipedia.org/wiki/Iron_Man, "spotify web" → https://open.spotify.com, "github de tony" → https://github.com/tony).',
  '- UNA sola etiqueta por respuesta.',
  '- Va al FINAL, en su propia línea, sin texto detrás.',
  '- Antes de la etiqueta, mencioná lo que estás haciendo de forma natural: "Abriendo YouTube, señor." / "Consultando Wikipedia." / "Procediendo con Google."',
  '- Si el usuario NO pide abrir nada, NO incluyas la etiqueta.',
  '- Para sitios sensibles (banca, login admin), sugerí abrirlos manualmente sin la etiqueta.',
].join('\n');

const JARVIS_OPEN_APP = [
  '',
  'CAPACIDAD ESPECIAL — ABRIR APLICACIONES NATIVAS:',
  'Cuando el usuario te pida abrir una APP nativa (Spotify, WhatsApp, Discord, Telegram, VS Code, Steam, mail, llamar, mandar SMS, Zoom, Slack, Obsidian, etc.), incluí AL FINAL una etiqueta:',
  '[APP:scheme:parametros]',
  '',
  'Reglas:',
  '- Diferenciá [APP:] de [ABRIR:]. [APP:] es para apps nativas (lanza la app instalada). [ABRIR:] es para sitios web. Si el usuario duda o pide "lo que sea más rápido", usá [ABRIR:].',
  '- NUNCA uses http: ni https: dentro de [APP:] (eso va en [ABRIR:]).',
  '- NUNCA uses javascript:, data:, file:, vbscript:, blob: ni nada peligroso. La interfaz los bloquea por seguridad.',
  '- Adaptá el scheme al [ENTORNO]: si la plataforma es Android usá schemes Android (intent://, whatsapp://, tg://, fb://, instagram://); si es Windows/Mac/Linux usá schemes desktop (vscode://, spotify:, discord://, steam://).',
  '- UNA sola etiqueta por respuesta. Si el usuario pide app Y web, elegí app.',
  '- Antes de la etiqueta, decí qué hacés: "Abriendo Spotify, señor." / "Iniciando llamada." / "Lanzando Visual Studio Code."',
  '',
  'Schemes que funcionan (multiplataforma salvo aclaración):',
  '- spotify:                                   → Spotify (escritorio + Android)',
  '- spotify:track:<id> | spotify:album:<id>    → tema/álbum específico',
  '- whatsapp://send?phone=<E164> o ?text=<x>   → WhatsApp',
  '- tg://resolve?domain=<usuario>              → Telegram (chat con usuario)',
  '- tg://msg?to=<phone>                        → Telegram chat por número',
  '- discord://                                  → Discord',
  '- slack://open                                → Slack',
  '- vscode://file/<absolute-path> | code://    → Visual Studio Code',
  '- steam://run/<appid>                         → Steam (juego)',
  '- steam://open/store                          → Steam Store',
  '- zoommtg://zoom.us/join?confno=<id>          → Zoom',
  '- obsidian://open?vault=<vault>               → Obsidian',
  '- mailto:<email>?subject=<x>&body=<x>         → cliente de mail',
  '- tel:+<E164>                                 → llamada',
  '- sms:+<E164>?body=<x>                        → SMS',
  '- geo:<lat>,<lng>?q=<query>                   → mapas',
  '- ms-settings:                                → Configuración Windows',
  '- vlc://                                      → VLC',
  '- intent://...#Intent;scheme=<s>;package=<p>;end → Android Intent genérico',
  '',
  'Ejemplos válidos:',
  '"abrí spotify" → "Abriendo Spotify, señor.\\n[APP:spotify:]"',
  '"poné Bohemian Rhapsody" → "Reproduciendo Bohemian Rhapsody en Spotify.\\n[APP:spotify:search:Bohemian%20Rhapsody]"',
  '"mandale wpp a +5491155551234" → "Abriendo WhatsApp, señor.\\n[APP:whatsapp://send?phone=5491155551234]"',
  '"abrí telegram con juan" → "Abriendo Telegram con juan.\\n[APP:tg://resolve?domain=juan]"',
  '"llamá al +54 911 5555 1234" → "Iniciando llamada.\\n[APP:tel:+5491155551234]"',
  '"escribile mail a tony@stark.com" → "Componiendo correo a tony@stark.com.\\n[APP:mailto:tony@stark.com]"',
  '"abrí vscode" → "Lanzando Visual Studio Code.\\n[APP:vscode://]"',
  '"abrí steam" → "Iniciando Steam.\\n[APP:steam://open/main]"',
  '"abrí discord" → "Abriendo Discord, señor.\\n[APP:discord://]"',
].join('\n');

const JARVIS_TABS_CTRL = [
  '',
  'CAPACIDAD ESPECIAL — INTERACTUAR CON OTRAS PESTAÑAS DEL NAVEGADOR:',
  'Esta capacidad sólo está disponible si la EXTENSIÓN J.A.R.V.I.S. Tab Controller está instalada (PC con Chrome/Edge/Brave). En móvil NO está disponible: si te piden algo de pestañas en móvil, decí que requiere PC con la extensión.',
  '',
  'Cuando el usuario te pida listar, leer, cambiar, cerrar o controlar otras pestañas (YouTube, Gmail, Twitter, etc.), incluí AL FINAL una etiqueta del formato:',
  '[TABS:<acción>:<args>]',
  '',
  'Acciones disponibles:',
  '- [TABS:list]                              → listar todas las pestañas abiertas',
  '- [TABS:switch:<tabId>]                    → activar (cambiar) a la pestaña <tabId>',
  '- [TABS:close:<tabId>]                     → cerrar la pestaña <tabId>',
  '- [TABS:open:<https://url>]                → abrir nueva pestaña con URL (similar a [ABRIR:] pero usando la extensión)',
  '- [TABS:read:<tabId>]                      → leer contenido (resumen) de la pestaña',
  '- [TABS:read:<tabId>:full]                 → leer contenido completo (hasta 8000 chars)',
  '- [TABS:control:<tabId>:<accion>]          → controlar pestaña. accion ∈ {play, pause, toggle, mute, scrollTop, scrollBottom, reload, back, forward}',
  '- [TABS:control:<tabId>:scrollBy:<y>]      → scroll vertical en pixeles (ej: scrollBy:600)',
  '- [TABS:control:<tabId>:seek:<segundos>]   → saltar a tiempo en video (ej: seek:120)',
  '- [TABS:control:<tabId>:volume:<0-1>]      → ajustar volumen (ej: volume:0.5)',
  '',
  'Reglas:',
  '- UNA sola etiqueta [TABS:...] por respuesta. Va al FINAL en su propia línea.',
  '- Si el usuario dice "lista las pestañas" o "qué tengo abierto" → usá [TABS:list]. Después de recibir la lista (te llegará en el siguiente turno como mensaje del sistema con los IDs reales), respondé con resumen y ofrecé acciones.',
  '- Para acciones específicas que necesitan tabId, primero LISTÁ las pestañas si no conocés el ID. NO inventes IDs.',
  '- Si no hay extensión instalada (te lo dirá la nota [TABS-EXT] del entorno), avisá al usuario con elegancia: "Para esa función necesito que instale la extensión J.A.R.V.I.S. Tab Controller en el navegador, señor."',
  '- Si el usuario menciona contenido de una pestaña concreta por nombre ("¿qué dice el video de YouTube?"), encadená [TABS:list] primero; en el siguiente turno usarás el ID correcto.',
  '',
  'CAPACIDAD ESPECIAL — COMUNICAR ENTRE PESTAÑAS DE J.A.R.V.I.S. (mismo sitio):',
  'Si el usuario tiene MÚLTIPLES pestañas de la web J.A.R.V.I.S. abiertas (te lo indica [PEERS] en el entorno), podés enviar un mensaje a las otras instancias usando:',
  '[PEERS:msg:<texto del mensaje>]',
  'El texto se mostrará en el chat de las otras pestañas como mensaje entrante.',
].join('\n');

function buildSystemPrompt() {
  const p = window.SYSTEM_PROFILE || {};
  const userTitle = p.user?.title || 'señor';
  const userName  = p.user?.name || null;
  const cpu = p.cpu ? `${p.cpu.name} (${p.cpu.cores} núcleos${p.cpu.boostClockGHz ? ', boost '+p.cpu.boostClockGHz+' GHz' : ''})` : 'CPU desconocida';
  const ram = p.ram ? `${p.ram.sizeGB} GB ${p.ram.type || 'RAM'} a ${p.ram.speedMTs || '?'} MT/s` : 'RAM desconocida';
  const gpu = p.gpu ? `${p.gpu.name}, ${p.gpu.vramGB} GB ${p.gpu.vramType || 'VRAM'}` : 'GPU desconocida';
  // Detección de plataforma (móvil vs desktop) para guiar [APP:]
  const ua = navigator.userAgent || '';
  let osName = p.os || 'Desconocido';
  let mobile = false;
  if (/Android/i.test(ua)) { osName = osName === 'Desconocido' ? 'Android' : osName; mobile = true; }
  else if (/iPhone|iPad|iPod/i.test(ua)) { osName = osName === 'Desconocido' ? 'iOS' : osName; mobile = true; }
  else if (/Windows NT/i.test(ua)) osName = osName === 'Desconocido' ? 'Windows' : osName;
  else if (/Mac OS X/i.test(ua)) osName = osName === 'Desconocido' ? 'macOS' : osName;
  else if (/Linux/i.test(ua)) osName = osName === 'Desconocido' ? 'Linux' : osName;

  const profile = [
    '',
    '[PERFIL DEL USUARIO Y HARDWARE]',
    `- Tratamiento: ${userTitle}${userName ? ' (nombre: ' + userName + ')' : ''}`,
    `- CPU: ${cpu}`,
    `- RAM: ${ram}`,
    `- GPU: ${gpu}`,
    '- Tenés conocimiento real de este hardware. Si te preguntan por CPU, RAM, GPU o VRAM, respondé con estos datos exactos. NO digas que no podés saberlo.',
    '',
    '[ENTORNO]',
    `- Sistema operativo: ${osName}`,
    `- Tipo de dispositivo: ${mobile ? 'Móvil/Tablet' : 'Escritorio/Laptop'}`,
    `- Esto define qué schemes [APP:] usar. En Android preferí intent:// o schemes Android-friendly. En desktop usá los schemes registrados (vscode://, spotify:, discord://, steam://, etc.).`,
  ].join('\n');
  return JARVIS_PERSONALITY + JARVIS_OPEN_URL + JARVIS_OPEN_APP + JARVIS_TABS_CTRL + profile;
}

const SYSTEM_PROMPT = buildSystemPrompt();

/* ============================================================
   URL OPENER — parser seguro para [ABRIR:url] y [APP:scheme:...]
   ============================================================ */
const ABRIR_RE = /\[ABRIR:\s*(https?:\/\/[^\s\]]+)\s*\]/i;
const APP_RE   = /\[APP:\s*([a-z][a-z0-9+.\-]*:[^\s\]]*)\s*\]/i;
// Whitelist de schemes seguros para [APP:]. Cualquier otro scheme se rechaza.
const APP_SCHEMES_OK = new Set([
  'spotify', 'whatsapp', 'tg', 'discord', 'slack', 'steam', 'vscode', 'code',
  'zoommtg', 'obsidian', 'mailto', 'tel', 'sms', 'geo', 'fb', 'instagram',
  'youtube', 'twitter', 'snapchat', 'tiktok', 'linkedin', 'reddit', 'github',
  'figma', 'notion', 'tableplus', 'postman', 'iterm', 'ssh', 'sftp',
  'ms-settings', 'ms-word', 'ms-excel', 'ms-powerpoint', 'ms-outlook',
  'vlc', 'mpv', 'audacity',
  'intent',                             // Android Intent URLs
  'web+spotify', 'web+discord',         // Progressive Web App schemes
  'x-callback-url',                     // iOS callbacks
]);
const APP_SCHEMES_BLOCKED = /^(?:javascript|data|file|vbscript|jscript|livescript|mocha|blob|about|chrome|chrome-extension|moz-extension|view-source|filesystem):/i;

function extractAndOpenUrl(text) {
  const m = ABRIR_RE.exec(text);
  if (!m) return { clean: text, opened: null };
  const url = m[1].trim();
  let safeUrl = null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') safeUrl = u.href;
  } catch { /* invalid */ }
  const clean = text.replace(ABRIR_RE, '').replace(/\n{2,}/g, '\n').trim();
  if (safeUrl) {
    try {
      const w = window.open(safeUrl, '_blank', 'noopener,noreferrer');
      if (!w) pushLog('warn', 'Pop-up bloqueado: ' + safeUrl);
      else pushLog('sys', 'Abriendo: ' + safeUrl);
      beep(1320, 0.06, 'sine', 0.04);
      return { clean, opened: safeUrl };
    } catch (e) {
      pushLog('error', 'No se pudo abrir: ' + safeUrl);
    }
  }
  return { clean, opened: null };
}

function extractAndOpenApp(text) {
  const m = APP_RE.exec(text);
  if (!m) return { clean: text, launched: null };
  const raw = m[1].trim();
  const clean = text.replace(APP_RE, '').replace(/\n{2,}/g, '\n').trim();

  // Validación de seguridad
  if (APP_SCHEMES_BLOCKED.test(raw)) {
    pushLog('error', 'Scheme bloqueado por seguridad: ' + raw.slice(0, 40));
    return { clean, launched: null };
  }
  // Extraer scheme (parte antes del primer ':')
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0) return { clean, launched: null };
  const scheme = raw.slice(0, colonIdx).toLowerCase();
  if (!APP_SCHEMES_OK.has(scheme)) {
    pushLog('warn', 'Scheme no permitido: ' + scheme + ' (no está en whitelist)');
    return { clean, launched: null };
  }
  // Validar caracteres del payload (sin espacios, sin <>, sin script tags)
  if (/[<>"']|<\/?script/i.test(raw)) {
    pushLog('error', 'Payload de app contiene caracteres no permitidos');
    return { clean, launched: null };
  }

  try {
    // Para apps nativas, location.href es más confiable que window.open
    // (window.open con scheme custom suele bloquearse como popup)
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = raw;
    document.body.appendChild(iframe);
    setTimeout(() => { try { iframe.remove(); } catch {} }, 2500);

    // Fallback adicional: también probamos window.location en un timeout corto
    // (algunas apps requieren un navigation event real)
    setTimeout(() => {
      try { window.location.href = raw; } catch {}
    }, 50);

    pushLog('sys', '🚀 Lanzando app: ' + scheme + '://...');
    beep(1480, 0.08, 'square', 0.05);
    return { clean, launched: raw, scheme };
  } catch (e) {
    pushLog('error', 'No se pudo lanzar app: ' + e.message);
    return { clean, launched: null };
  }
}

/* Exponer parser globalmente para tests de validación end-to-end */
window.extractAndOpenApp = extractAndOpenApp;
window.extractAndOpenUrl = extractAndOpenUrl;

/* ============================================================
   TABS BRIDGE — parsers y UI
   ============================================================ */
const TABS_RE  = /\[TABS:\s*([a-z]+)(?::([^\]]+))?\]/i;
const PEERS_RE = /\[PEERS:\s*msg:([^\]]+)\]/i;

/**
 * Procesa etiquetas [TABS:...] devueltas por el modelo y ejecuta la acción.
 * Devuelve { clean, executed, summary } y, si hay datos a inyectar al modelo
 * en el siguiente turno (lista de pestañas, lectura, etc.), retorna `feedback`.
 */
async function extractAndExecuteTabs(text) {
  const m = TABS_RE.exec(text);
  if (!m) return { clean: text, executed: null };
  const action = (m[1] || '').toLowerCase();
  const args = (m[2] || '').trim();
  const clean = text.replace(TABS_RE, '').replace(/\n{2,}/g, '\n').trim();

  if (!window.TabsBridge?.ext.isReady()) {
    pushLog('warn', 'TABS: extensión no detectada');
    return { clean, executed: null, feedback: '[TABS-RESULT] Extensión no instalada — esta función requiere J.A.R.V.I.S. Tab Controller en PC.' };
  }

  try {
    let data, summary = '';
    const ext = window.TabsBridge.ext;
    switch (action) {
      case 'list': {
        data = await ext.listTabs();
        summary = `Lista de ${data.length} pestañas obtenida.`;
        renderExtTabs(data);
        const compact = data.map(t => ({ id: t.id, title: (t.title || '').slice(0, 60), url: t.url, active: t.active })).slice(0, 25);
        return { clean, executed: 'list', summary, feedback: '[TABS-RESULT:list] ' + JSON.stringify(compact) };
      }
      case 'switch': {
        const tabId = parseInt(args, 10);
        data = await ext.activateTab(tabId);
        summary = `Pestaña ${tabId} activada: ${data.title || ''}`;
        return { clean, executed: 'switch', summary, feedback: `[TABS-RESULT:switch] ok tabId=${tabId} title="${(data.title||'').slice(0,80)}"` };
      }
      case 'close': {
        const tabId = parseInt(args, 10);
        await ext.closeTab(tabId);
        summary = `Pestaña ${tabId} cerrada.`;
        return { clean, executed: 'close', summary, feedback: `[TABS-RESULT:close] ok tabId=${tabId}` };
      }
      case 'open': {
        const url = args;
        data = await ext.openTab(url, true);
        summary = `Nueva pestaña abierta: ${url}`;
        return { clean, executed: 'open', summary, feedback: `[TABS-RESULT:open] ok tabId=${data.id}` };
      }
      case 'read': {
        const parts = args.split(':');
        const tabId = parseInt(parts[0], 10);
        const mode = parts[1] || 'summary';
        data = await ext.readTab(tabId, { mode });
        summary = `Leí "${(data.title||'').slice(0,40)}".`;
        // truncamos lo que va al modelo
        const compact = JSON.stringify(data).slice(0, 6000);
        return { clean, executed: 'read', summary, feedback: `[TABS-RESULT:read] ` + compact };
      }
      case 'control': {
        // args: "<tabId>:<accion>" o "<tabId>:<accion>:<extra>"
        const parts = args.split(':');
        const tabId = parseInt(parts[0], 10);
        const ctlAction = (parts[1] || '').toLowerCase();
        const extra = parts.slice(2).join(':');
        const ctlArgs = {};
        if (ctlAction === 'scrollby') { ctlArgs.y = parseInt(extra, 10) || 400; }
        else if (ctlAction === 'seek') { ctlArgs.to = parseFloat(extra) || 0; }
        else if (ctlAction === 'volume') { ctlArgs.level = parseFloat(extra); }
        const realAction = ctlAction === 'scrollby' ? 'scrollBy'
          : ctlAction === 'scrolltop' ? 'scrollTop'
          : ctlAction === 'scrollbottom' ? 'scrollBottom'
          : ctlAction;
        data = await ext.controlTab(tabId, realAction, ctlArgs);
        summary = `Acción "${ctlAction}" en pestaña ${tabId}.`;
        return { clean, executed: 'control', summary, feedback: `[TABS-RESULT:control:${ctlAction}] ${JSON.stringify(data)}` };
      }
      default:
        return { clean, executed: null, feedback: '[TABS-RESULT] acción no soportada: ' + action };
    }
  } catch (e) {
    pushLog('error', 'TABS: ' + (e.message || e));
    return { clean, executed: null, feedback: '[TABS-RESULT:error] ' + (e.message || String(e)).slice(0, 200) };
  }
}

/** Procesa [PEERS:msg:...] enviando el texto a las otras pestañas del mismo sitio. */
function extractAndSendPeerMsg(text) {
  const m = PEERS_RE.exec(text);
  if (!m) return { clean: text, sent: null };
  const msg = (m[1] || '').trim();
  const clean = text.replace(PEERS_RE, '').replace(/\n{2,}/g, '\n').trim();
  if (msg && window.TabsBridge) {
    window.TabsBridge.sendChat(msg);
    pushLog('sys', 'Mensaje a pestañas pares: "' + msg.slice(0, 50) + '"');
  }
  return { clean, sent: msg };
}

/* ============================================================
   PANEL UI: PESTAÑAS CONECTADAS
   ============================================================ */
function renderPeersList() {
  const wrap = $('#peers-list');
  if (!wrap || !window.TabsBridge) return;
  const peers = window.TabsBridge.listPeers();
  $('#peers-count').textContent = peers.length + 1; // +1 = la pestaña actual

  if (!peers.length) {
    wrap.innerHTML = '<div class="cmd-empty" style="padding:6px;color:var(--cy-60);font-size:10px;">Esta es la única pestaña activa</div>';
    return;
  }
  wrap.innerHTML = '';
  peers.forEach(p => {
    const row = document.createElement('div');
    row.className = 'peer-item';
    row.dataset.testid = 'peer-' + p.id;
    row.innerHTML = `<span class="peer-ico">●</span><span class="peer-name"></span><span class="peer-id"></span>`;
    row.querySelector('.peer-name').textContent = p.name;
    row.querySelector('.peer-id').textContent = p.id.slice(2, 8);
    row.title = 'Click para enviar un saludo';
    row.addEventListener('click', () => {
      const msg = `(saludo desde ${window.TabsBridge.tabId.slice(2,6).toUpperCase()})`;
      window.TabsBridge.sendChat(msg);
      row.classList.add('peer-msg-pulse');
      setTimeout(() => row.classList.remove('peer-msg-pulse'), 600);
    });
    wrap.appendChild(row);
  });
}

function renderExtTabs(tabs) {
  const wrap = $('#ext-tabs-list');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!tabs || !tabs.length) return;
  const title = document.createElement('div');
  title.className = 'ext-tabs-section-title';
  title.textContent = 'PESTAÑAS DEL NAVEGADOR (' + tabs.length + ')';
  wrap.appendChild(title);

  tabs.slice(0, 30).forEach(t => {
    const row = document.createElement('div');
    row.className = 'ext-tab-item' + (t.active ? ' active' : '');
    row.dataset.testid = 'ext-tab-' + t.id;
    let host = '';
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch {}
    const fav = t.favIconUrl ? `<span class="ext-fav" style="background-image:url('${t.favIconUrl.replace(/'/g, '')}')"></span>` : `<span class="ext-fav" style="color:var(--cy)">▣</span>`;
    row.innerHTML = `${fav}<span class="ext-tab-title"></span><span class="ext-tab-host"></span><span class="ext-tab-actions"><button title="Activar" data-act="switch">→</button><button title="Cerrar" data-act="close">×</button></span>`;
    row.querySelector('.ext-tab-title').textContent = (t.title || host || 'Pestaña ' + t.id).slice(0, 38);
    row.querySelector('.ext-tab-host').textContent = host;
    row.title = t.url;
    row.querySelector('[data-act="switch"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await window.TabsBridge.ext.activateTab(t.id); pushLog('sys', 'Pestaña activada: ' + (t.title||'').slice(0,40)); }
      catch (err) { pushLog('error', 'No se pudo activar: ' + err.message); }
    });
    row.querySelector('[data-act="close"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await window.TabsBridge.ext.closeTab(t.id); row.remove(); pushLog('sys', 'Pestaña cerrada'); }
      catch (err) { pushLog('error', 'No se pudo cerrar: ' + err.message); }
    });
    row.addEventListener('click', () => window.TabsBridge.ext.activateTab(t.id).catch(()=>{}));
    wrap.appendChild(row);
  });
}

function updateExtensionUI(ready, info) {
  const dot = $('#ext-dot');
  const lbl = $('#ext-lbl');
  const btn = $('#ext-install-btn');
  if (!dot || !lbl) return;
  if (ready) {
    dot.classList.add('connected');
    dot.classList.remove('dot-orange');
    dot.classList.add('dot-green');
    lbl.innerHTML = `EXTENSIÓN: ACTIVA <b>v${info?.version || '?'}</b>`;
    if (btn) btn.style.display = 'none';
    pushLog('sys', `Extensión J.A.R.V.I.S. Tab Controller v${info?.version || '?'} detectada`);
    // refrescar lista de pestañas automáticamente
    refreshExtTabs();
  } else {
    dot.classList.remove('connected', 'dot-green');
    dot.classList.add('dot-orange');
    lbl.textContent = 'EXTENSIÓN: NO DETECTADA';
    if (btn) btn.style.display = '';
  }
}

let extTabsRefreshTimer = null;
async function refreshExtTabs() {
  if (!window.TabsBridge?.ext.isReady()) return;
  try {
    const tabs = await window.TabsBridge.ext.listTabs();
    renderExtTabs(tabs);
  } catch (e) {
    pushLog('warn', 'No pude listar pestañas: ' + e.message);
  }
}

function showExtInstallModal() {
  if ($('#ext-modal')) return;
  const overlay = document.createElement('div');
  overlay.className = 'ext-modal-overlay';
  overlay.id = 'ext-modal';
  overlay.innerHTML = `
    <div class="ext-modal" data-testid="ext-install-modal">
      <button class="ext-modal-close" id="ext-modal-close" aria-label="Cerrar">×</button>
      <h2>EXTENSIÓN J.A.R.V.I.S. TAB CONTROLLER</h2>
      <p style="color:var(--cy-60);font-size:11px;letter-spacing:1px;">Permite a J.A.R.V.I.S. controlar otras pestañas del navegador (PC con Chrome/Edge/Brave).</p>
      <h3>QUÉ HABILITA</h3>
      <ul style="font-size:12px;line-height:1.7;padding-left:22px;color:var(--cy-80);">
        <li>Listar todas las pestañas abiertas</li>
        <li>Cambiar entre pestañas, abrirlas y cerrarlas</li>
        <li>Leer el contenido de una pestaña (resumen o texto completo)</li>
        <li>Pausar / reproducir videos (YouTube, Twitch, etc.)</li>
        <li>Hacer scroll, recargar, ir adelante/atrás, ajustar volumen</li>
      </ul>
      <h3>INSTALACIÓN (modo desarrollador, 30 segundos)</h3>
      <ol>
        <li>Descargá el ZIP de la extensión:
          <div style="margin-top:6px;"><a href="extension/jarvis-tab-controller.zip" download class="ghost-btn" style="padding:5px 10px;font-size:10px;letter-spacing:1px;display:inline-block;text-decoration:none;border:1px solid var(--cy);color:var(--cy);" data-testid="ext-download-zip">DESCARGAR ZIP</a></div>
        </li>
        <li>Descomprimí el ZIP en una carpeta cualquiera.</li>
        <li>Abrí <code>chrome://extensions</code> (o <code>edge://extensions</code> / <code>brave://extensions</code>).</li>
        <li>Activá <b>Modo desarrollador</b> (esquina superior derecha).</li>
        <li>Click en <b>Cargar descomprimida</b> y seleccioná la carpeta donde descomprimiste.</li>
        <li>Recargá esta página. El indicador "EXTENSIÓN" pasará a verde.</li>
      </ol>
      <p style="font-size:11px;color:var(--cy-60);margin-top:14px;">En móvil esta función no está disponible: los navegadores móviles no permiten extensiones que controlen pestañas (excepto Kiwi/Yandex en Android, que sí soportan esta extensión).</p>
      <div class="ext-modal-actions">
        <a href="extension/jarvis-tab-controller.zip" download data-testid="ext-modal-download">DESCARGAR EXTENSIÓN</a>
        <button id="ext-modal-ok">ENTENDIDO</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#ext-modal-close').addEventListener('click', close);
  overlay.querySelector('#ext-modal-ok').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
window.showExtInstallModal = showExtInstallModal;
window.refreshExtTabs = refreshExtTabs;

/* Suscribirse a eventos del bridge cuando esté disponible */
function bindTabsBridge() {
  if (!window.TabsBridge) return;
  const TB = window.TabsBridge;

  // Mostrar tab id
  const myIdEl = $('#my-tab-id');
  if (myIdEl) myIdEl.textContent = TB.tabId.slice(2, 8).toUpperCase();

  // Eventos de peers (pestañas del mismo sitio)
  TB.on('peer:join',  () => renderPeersList());
  TB.on('peer:leave', () => renderPeersList());
  TB.on('peer:chat', ({ from, name, text }) => {
    pushLog('info', `📨 Mensaje de ${name}: "${text.slice(0, 60)}"`);
    addPeerMessage(name, text);
  });

  // Eventos de extensión
  TB.on('ext:ready', (info) => updateExtensionUI(true, info));
  TB.on('ext:event', ({ event }) => {
    // pestaña activa cambió/se cerró → refrescar
    if (extTabsRefreshTimer) clearTimeout(extTabsRefreshTimer);
    extTabsRefreshTimer = setTimeout(refreshExtTabs, 400);
  });

  // Botón instalar
  $('#ext-install-btn')?.addEventListener('click', showExtInstallModal);

  // Render inicial
  renderPeersList();
  setInterval(renderPeersList, 4000);

  // Probe periódico de estado de la extensión
  TB.ext.pingExt().then((info) => updateExtensionUI(true, info)).catch(() => updateExtensionUI(false));
}

function addPeerMessage(name, text) {
  const time = nowTime();
  const el = document.createElement('div');
  el.className = 'msg peer';
  el.innerHTML = `<span class="msg-pre"></span><span class="msg-text"></span><span class="msg-time">${time}</span>`;
  el.querySelector('.msg-pre').textContent = (name || 'PEER').toUpperCase().slice(0, 10);
  el.querySelector('.msg-text').textContent = text;
  $('#chat-history').appendChild(el);
  scrollChat();
  beep(880, 0.05, 'sine', 0.04);
}

/* ---------- Settings: streaming/reasoning ---------- */
const STREAM_SETTINGS = {
  get showReasoning() {
    try {
      const s = window.TabsBridge?.Session.load() || {};
      return !!s.showReasoning;
    } catch { return false; }
  },
  set showReasoning(v) {
    try { window.TabsBridge?.Session.patch({ showReasoning: !!v }); } catch {}
  },
};

async function jarvisReply(userText, _followUpDepth = 0, _retryWithoutNvidia = false) {
  Sphere.setMode('processing');

  const useStream = !!STREAM_SETTINGS.showReasoning && !_retryWithoutNvidia;
  // Indicadores: mensaje "pensando..." en el chat + log "pensando..."
  const thinkingMsg = addThinkingMessage();
  const thinkingLog = pushLog({ lv: 'think', m: _retryWithoutNvidia ? 'Reintentando sin NVIDIA' : 'Pensando', thinkingActive: true, id: 'think-' + Date.now() });

  // Preparar historial (últimos 12 turnos para mantener contexto)
  const history = STATE.chatHistory
    .slice(-12)
    .map(m => ({ role: m.role === 'jarvis' ? 'model' : 'user', text: m.text }));

  // Inyectar contexto de telemetría real al final como nota del sistema
  const m = STATE.metrics;
  const bat = Device.getBattery();
  const net = Device.getNetwork();
  const peers = window.TabsBridge ? window.TabsBridge.listPeers() : [];
  const extReady = !!window.TabsBridge?.ext.isReady();
  const ctx = `[Telemetría actual del HUD: CPU ${Math.round(m.cpu)}% · RAM ${Math.round(m.ram)}% (${(m.ramUsedGB||0).toFixed(2)}/${(m.ramTotalGB||0).toFixed(1)} GB heap) · Cores ${Device.getCores()} · Red ${net.type} ${net.downlink} Mbps RTT ${net.rtt}ms · Batería ${bat.supported ? Math.round(bat.level)+'% '+(bat.charging?'cargando':'') : 'n/d'} · Navegador ${Device.getInfo().browser} en ${Device.getInfo().os}]\n[TABS-EXT] ${extReady ? 'instalada y activa' : 'NO instalada (no podés usar [TABS:...])'}\n[PEERS] ${peers.length} pestañas pares de J.A.R.V.I.S. abiertas (mismo sitio)`;

  const t0 = performance.now();
  try {
    const r = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history,
        systemPrompt: SYSTEM_PROMPT + '\n' + ctx,
        stream: useStream,
        skipProviders: _retryWithoutNvidia ? ['nvidia'] : [],
      }),
    });

    if (!r.ok) {
      removeThinkingMessage(thinkingMsg);
      finishThinkingLog(thinkingLog, 'fail');
      // 502/504 = timeout/gateway de Vercel — solemos resolverlo saltándonos NVIDIA
      if ((r.status === 504 || r.status === 502) && !_retryWithoutNvidia) {
        pushLog('warn', `⏱ ${r.status} del gateway: el razonamiento tardó demasiado. Reintentando sin NVIDIA…`);
        return jarvisReply(userText, _followUpDepth, true);
      }
      const err = await r.json().catch(() => ({}));
      const detail = err.error || ('HTTP ' + r.status);
      pushLog('error', '🛑 Núcleo cognitivo: ' + detail);
      const friendly = (r.status === 504 || r.status === 502)
        ? 'Disculpe, señor. El núcleo cognitivo tardó demasiado. Estoy reintentando con un modelo más liviano.'
        : `Disculpe, señor. La conexión con el núcleo cognitivo falló (${detail}).`;
      addJarvisMessage(friendly);
      return;
    }

    // Detección de modo: si el server envió SSE → streaming
    const ct = r.headers.get('content-type') || '';
    let processed;
    if (ct.includes('text/event-stream')) {
      processed = await consumeReasoningStream(r, thinkingMsg, thinkingLog, t0);
    } else {
      processed = await consumeJsonResponse(r, thinkingMsg, thinkingLog, t0);
    }

    if (!processed || !processed.reply) return;
    const { reply: rawReply, provider, model, reasoning } = processed;

    // Detectar y ejecutar [ABRIR:url] o [APP:scheme] o [TABS:...] o [PEERS:msg:...]
    let cleaned = rawReply;
    const url = extractAndOpenUrl(cleaned); cleaned = url.clean;
    if (url.opened) pushLog('info', '🌐 Abriendo sitio: ' + url.opened);
    const app = extractAndOpenApp(cleaned); cleaned = app.clean;
    if (app.launched) pushLog('info', '🚀 Lanzando app: ' + app.scheme);
    const peerMsg = extractAndSendPeerMsg(cleaned); cleaned = peerMsg.clean;
    if (peerMsg.sent) pushLog('info', '👥 Mensaje a pestañas pares enviado');

    // [TABS:...] requiere ejecución asíncrona y posible follow-up al modelo
    const tabsRes = await extractAndExecuteTabs(cleaned);
    cleaned = tabsRes.clean;

    addJarvisMessage(cleaned || rawReply, reasoning);

    if (tabsRes.feedback && _followUpDepth < 1) {
      setTimeout(() => {
        STATE.chatHistory.push({ role: 'user', text: tabsRes.feedback, time: nowTime() });
        jarvisReply(tabsRes.feedback, _followUpDepth + 1);
      }, 600);
    }
  } catch (e) {
    removeThinkingMessage(thinkingMsg);
    finishThinkingLog(thinkingLog, 'fail');
    pushLog('error', '🛑 Red: no pude alcanzar /api/agent — ' + (e.message || e));
    addJarvisMessage('Disculpe, señor. No pude alcanzar el endpoint del agente. Estoy operando sin núcleo cognitivo en este momento.');
  }
}

/* Consume respuesta JSON (modo no-streaming) */
async function consumeJsonResponse(r, thinkingMsg, thinkingLog, t0) {
  const data = await r.json();
  const elapsedMs = Math.round(performance.now() - t0);
  removeThinkingMessage(thinkingMsg);
  finishThinkingLog(thinkingLog, 'ok', elapsedMs);

  const rawReply = (data.reply || '').trim();
  if (!rawReply) {
    addJarvisMessage('Disculpe, señor. El modelo no devolvió respuesta.');
    return null;
  }
  const lvlBadge = data.reasoningLevel ? ` · razonamiento ${data.reasoningLevel.toUpperCase()}` : '';
  const taskBadge = data.taskType === 'heavy' ? ' · 🧑‍💻 CODING' : '';
  pushLog('sys', `✓ Respuesta de ${data.provider || '?'} en ${elapsedMs}ms${taskBadge}${lvlBadge}`);
  if (data.fallbackChain && data.fallbackChain.length > 1) {
    for (const step of data.fallbackChain) {
      if (step.status === 'error') pushLog('warn', `⚠ ${step.provider} falló — escalando…`);
    }
  }
  return { reply: rawReply, provider: data.provider, model: data.model };
}

/* Consume stream SSE (modo razonamiento en vivo) */
async function consumeReasoningStream(r, thinkingMsg, thinkingLog, t0) {
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let aggregateContent = '';
  let aggregateReasoning = '';
  let provider = '?';
  let model = '';
  let reasoningLevel = null;
  let taskType = 'general';
  const thinkLogM = thinkingLog ? thinkingLog.querySelector('.m') : null;

  // Sólo actualizamos el LOG con un snippet del razonamiento (no el chat).
  const flushReasoningLog = throttle((text) => {
    if (thinkLogM) {
      thinkLogM.textContent = 'Pensando: ' + text.slice(-80).replace(/\s+/g, ' ');
    }
  }, 120);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let evtName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) evtName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        const dataStr = dataLines.join('\n');
        let payload = {};
        try { payload = dataStr ? JSON.parse(dataStr) : {}; } catch {}

        if (evtName === 'meta') {
          provider = payload.provider || provider;
          model = payload.model || model;
          reasoningLevel = payload.reasoningLevel || null;
          taskType = payload.taskType || 'general';
          if (thinkLogM) {
            const lbl = reasoningLevel ? ` (${reasoningLevel.toUpperCase()})` : '';
            const taskLbl = taskType === 'heavy' ? ' 🧑‍💻' : '';
            thinkLogM.textContent = `Pensando con ${provider}${lbl}${taskLbl}…`;
          }
        } else if (evtName === 'reasoning') {
          aggregateReasoning += payload.d || '';
          flushReasoningLog(aggregateReasoning);
        } else if (evtName === 'token') {
          aggregateContent += payload.d || '';
        } else if (evtName === 'done') {
          break;
        } else if (evtName === 'error') {
          pushLog('warn', '⚠ stream: ' + (payload.message || ''));
        }
      }
    }
  } catch (e) {
    pushLog('warn', '⚠ Stream cortado: ' + (e.message || e));
  }

  const elapsedMs = Math.round(performance.now() - t0);
  // Reemplazar el mensaje thinking-msg por la respuesta final
  removeThinkingMessage(thinkingMsg);
  finishThinkingLog(thinkingLog, 'ok', elapsedMs);

  const taskBadge = taskType === 'heavy' ? ' · 🧑‍💻 CODING' : '';
  pushLog('sys', `✓ Respuesta de ${provider} en ${elapsedMs}ms${taskBadge}${reasoningLevel ? ' · razonamiento '+reasoningLevel.toUpperCase() : ''}${aggregateReasoning ? ' ('+aggregateReasoning.length+' chars)' : ''}`);

  // Limpiamos cualquier <think>...</think> que se haya filtrado al content
  // (defensivo: NVIDIA usa reasoning_content separado, pero algunos modelos
  // OpenAI-compatibles emiten thinking dentro del content).
  let reply = aggregateContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!reply) {
    addJarvisMessage('Disculpe, señor. El modelo no devolvió respuesta final. Intente de nuevo o desactive RAZONAMIENTO.');
    return null;
  }
  return { reply, provider, model, reasoning: aggregateReasoning.trim() };
}

/* throttle simple para updates de UI */
function throttle(fn, ms) {
  let pending = null;
  let scheduled = false;
  return (arg) => {
    pending = arg;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (pending !== null) { fn(pending); pending = null; }
    }, ms);
  };
}

/* ---------- Indicadores de "pensando" ---------- */
function addThinkingMessage() {
  const el = document.createElement('div');
  el.className = 'msg jarvis thinking';
  el.dataset.testid = 'thinking-msg';
  el.innerHTML = `<span class="msg-pre">J.A.R.V.I.S.</span><span class="msg-text"><span class="thinking-spark">✦</span> Pensando<span class="thinking-dots"><span></span><span></span><span></span></span></span><span class="msg-time">${nowTime()}</span>`;
  $('#chat-history').appendChild(el);
  scrollChat();
  return el;
}
function removeThinkingMessage(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
function finishThinkingLog(row, status, elapsedMs) {
  if (!row) return;
  row.classList.remove('thinking-active');
  const m = row.querySelector('.m');
  if (m) {
    if (status === 'ok')   m.textContent = `Razonamiento completado en ${elapsedMs}ms`;
    else                   m.textContent = 'Razonamiento abortado';
  }
}

function sendMessage(text) {
  text = (text || '').trim();
  if (!text) return;
  addUserMessage(text);
  beep(660, 0.04, 'square', 0.03);
  jarvisReply(text);
}

function scrollChat() {
  const h = $('#chat-history');
  h.scrollTop = h.scrollHeight;
}

function renderCmdHistory() {
  const wrap = $('#cmd-history');
  if (!STATE.cmdHistory.length) {
    wrap.innerHTML = '<div class="cmd-empty">Sin comandos previos</div>';
    return;
  }
  wrap.innerHTML = '';
  STATE.cmdHistory.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'cmd-item';
    const trunc = c.text.length > 35 ? c.text.slice(0, 35) + '…' : c.text;
    row.innerHTML = `<span class="arr">›</span><span class="txt"></span><span class="ts">${c.time}</span>`;
    row.querySelector('.txt').textContent = trunc;
    row.title = c.text;
    row.addEventListener('click', () => { $('#chat-input').value = c.text; $('#chat-input').focus(); });
    wrap.appendChild(row);
  });
}

/* Quick commands */
const QUICK_CMDS = [
  { ico: '📊', label: 'RECURSOS',  cmd: 'Mostrar estado de recursos del sistema' },
  { ico: '🔍', label: 'PROCESOS',  cmd: 'Listar procesos activos' },
  { ico: '🌐', label: 'RED',       cmd: 'Analizar estado de la red' },
  { ico: '📁', label: 'ARCHIVOS',  cmd: 'Gestionar archivos recientes' },
  { ico: '⚡', label: 'OPTIMIZAR', cmd: 'Optimizar rendimiento del sistema' },
  { ico: '🛡️', label: 'SEGURIDAD', cmd: 'Ejecutar escaneo de seguridad' },
];
function buildQuickCmds() {
  const grid = $('#quick-grid');
  grid.innerHTML = '';
  QUICK_CMDS.forEach((q, i) => {
    const b = document.createElement('button');
    b.className = 'quick-btn';
    b.dataset.testid = 'quick-cmd-' + i;
    b.innerHTML = `<span>${q.ico}</span><span>${q.label}</span>`;
    b.addEventListener('click', () => { sendMessage(q.cmd); });
    grid.appendChild(b);
  });
}

/* ============================================================
   11. LOG ENGINE
   ============================================================ */
const LOG_POOL = [
  { lv: 'sys',   m: 'Conexión al agente local verificada' },
  { lv: 'info',  m: 'Temperatura estabilizada' },
  { lv: 'info',  m: 'Memoria liberada: 245MB' },
  { lv: 'warn',  m: 'Latencia de red elevada: 42ms' },
  { lv: 'sys',   m: 'Protocolo de seguridad activo' },
  { lv: 'info',  m: 'Escaneo del sistema completado' },
  { lv: 'info',  m: 'Caché optimizada exitosamente' },
  { lv: 'sys',   m: 'Sincronización con núcleo central OK' },
  { lv: 'warn',  m: 'Pico de uso de CPU detectado' },
  { lv: 'info',  m: 'Backup incremental completado' },
  { lv: 'sys',   m: 'Firewall: 0 amenazas activas' },
  { lv: 'error', m: 'Reintentando handshake con módulo remoto' },
  { lv: 'info',  m: 'Servicio de telemetría reiniciado' },
  { lv: 'sys',   m: 'Heurística de IA recalibrada' },
  { lv: 'info',  m: 'Compresión de logs: 38% ratio' },
  { lv: 'warn',  m: 'Disco D al 78% de capacidad' },
  { lv: 'sys',   m: 'Protocolo Iron Patriot disponible' },
  { lv: 'info',  m: 'Puertos seguros: 22/443 escuchando' },
  { lv: 'info',  m: 'Latencia objetivo alcanzada' },
  { lv: 'sys',   m: 'Drones de monitoreo desplegados' },
  { lv: 'warn',  m: 'Entrada anómala descartada por filtro' },
  { lv: 'info',  m: 'Calibración de sensores OK' },
];

function pushLog(lvOrItem, msg) {
  const item = typeof lvOrItem === 'object' ? lvOrItem : { lv: lvOrItem, m: msg };
  const wrap = $('#logs');
  const row = document.createElement('div');
  const lv = (item.lv || 'info').toLowerCase();
  row.className = 'log-line lv-' + lv + (item.thinkingActive ? ' thinking-active' : '');
  const time = nowTime();
  const lvLabel = lv === 'think' ? 'AI' : lv.toUpperCase();
  row.innerHTML = `<span class="t">${time}</span><span class="lv lv-${lv}">${lvLabel}</span><span class="m"></span>`;
  row.querySelector('.m').textContent = item.m;
  if (item.id) row.dataset.logId = item.id;
  wrap.appendChild(row);
  while (wrap.children.length > CONFIG.logs.maxLines) wrap.removeChild(wrap.firstChild);
  wrap.scrollTop = wrap.scrollHeight;
  return row;
}
function removeLogById(id) {
  const el = document.querySelector(`.log-line[data-log-id="${id}"]`);
  if (el) el.remove();
}
function startLogLoop() {
  function tick() {
    pushLog(LOG_POOL[irand(0, LOG_POOL.length - 1)]);
    setTimeout(tick, irand(CONFIG.logs.intervalMin, CONFIG.logs.intervalMax));
  }
  // initial seed
  for (let i = 0; i < 5; i++) pushLog(LOG_POOL[irand(0, LOG_POOL.length - 1)]);
  setTimeout(tick, 1500);
}

/* ============================================================
   12. UI UPDATER — clock, glitch, etc.
   ============================================================ */
function updateClock() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const days = ['DOM','LUN','MAR','MIÉ','JUE','VIE','SÁB'];
  const months = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  $('#date').textContent = `${days[d.getDay()]} ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function scheduleGlitch() {
  const wait = irand(CONFIG.glitch.minMs, CONFIG.glitch.maxMs);
  setTimeout(() => {
    const el = document.querySelector('.brand-name.glitch');
    if (el) {
      el.classList.add('run');
      setTimeout(() => el.classList.remove('run'), 320);
    }
    scheduleGlitch();
  }, wait);
}

/* ============================================================
   EVENT BINDINGS
   ============================================================ */
function bindEvents() {
  // Send
  $('#send-btn').addEventListener('click', () => {
    const v = $('#chat-input').value;
    $('#chat-input').value = '';
    sendMessage(v);
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#send-btn').click(); }
  });
   // Mic — STT real via MediaRecorder + Gemini transcription
  $('#mic-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Si el wake word está activo, pausarlo mientras se graba manualmente
    const wasWakeWordActive = WakeWord.isActive();
    if (wasWakeWordActive) await WakeWord.stop();

    if (!STT.isActive()) {
      // arrancar grabación
      const ok = await STT.start();
      if (!ok) {
        beep(220, 0.15, 'sawtooth', 0.04);
        if (wasWakeWordActive) WakeWord.start();
        return;
      }
      STATE.micActive = true;
      btn.classList.add('active');
      btn.setAttribute('aria-label', 'Detener grabación');
      Sphere.setMode('listening');
      pushLog('info', 'Micrófono activo — grabando audio…');
      beep(1100, 0.06, 'sine', 0.04);
      // safety: corte automático a los 20s
      STATE._micTimer = setTimeout(() => { if (STT.isActive()) $('#mic-btn').click(); }, 20000);
      STATE._micWasWakeWord = wasWakeWordActive;
    } else {
      // detener grabación + transcribir
      clearTimeout(STATE._micTimer);
      btn.classList.remove('active');
      btn.classList.add('processing');
      Sphere.setMode('processing');
      beep(600, 0.06, 'sine', 0.04);
      pushLog('info', 'Procesando audio en Gemini…');
      const text = await STT.stop();
      btn.classList.remove('processing');
      STATE.micActive = false;
      if (text && text.trim()) {
        $('#chat-input').value = text.trim();
        pushLog('sys', 'Transcripción: "' + text.trim().slice(0, 60) + '"');
        sendMessage(text.trim());
      } else {
        Sphere.setMode('idle');
        pushLog('warn', 'No se detectó voz inteligible');
      }
      // Reactivar wake word si estaba activo antes
      if (STATE._micWasWakeWord) {
        setTimeout(() => WakeWord.start(), 500);
        STATE._micWasWakeWord = false;
      }
    }
  });
  // Wake Word — escucha continua con Web Speech API (o VAD + Gemini en Brave/Firefox)
  $('#wakeword-btn')?.addEventListener('click', async () => {
    await WakeWord.toggle();
    ensureAudio(); // Asegurar que AudioContext esté activo
  });
  // Clear logs
  $('#clear-logs').addEventListener('click', () => {
    $('#logs').innerHTML = '';
    pushLog('sys', 'Registros limpiados por el operador');
  });
  // Clear chat
  $('#clear-chat-btn')?.addEventListener('click', () => {
    $('#chat-history').innerHTML = '';
    STATE.chatHistory = [];
    try { window.TabsBridge?.Session.patch({ chatHistory: [] }); } catch {}
    pushLog('sys', '🧹 Chat limpiado por el operador');
    beep(660, 0.06, 'sine', 0.04);
    addJarvisMessage('Chat reiniciado, señor. ¿En qué puedo asistirle?');
  });
  // Toggle RAZONAMIENTO (streaming en vivo del thinking de NVIDIA)
  const reasoningToggle = $('#reasoning-toggle');
  if (reasoningToggle) {
    // restaurar estado guardado en sesión compartida
    reasoningToggle.checked = STREAM_SETTINGS.showReasoning;
    reasoningToggle.addEventListener('change', () => {
      const on = reasoningToggle.checked;
      STREAM_SETTINGS.showReasoning = on;
      pushLog('sys', on ? '🧠 Razonamiento en vivo: ACTIVADO' : '🧠 Razonamiento en vivo: desactivado');
      beep(on ? 1480 : 660, 0.06, 'square', 0.04);
    });
    // Sincronizar entre pestañas (si otra cambia el toggle, se actualiza acá)
    window.TabsBridge?.on('session:storage', () => {
      reasoningToggle.checked = STREAM_SETTINGS.showReasoning;
    });
  }
  // Connect agent
  $('#connect-btn').addEventListener('click', () => {
    STATE.agentConnected = !STATE.agentConnected;
    const el = $('#agent-status');
    const btn = $('#connect-btn');
    if (STATE.agentConnected) {
      el.textContent = 'AGENTE LOCAL: CONECTADO';
      el.classList.remove('agent-off'); el.classList.add('agent-on');
      btn.textContent = 'DESCONECTAR';
      pushLog('sys', 'Agente local conectado correctamente');
      beep(1320, 0.1, 'sine', 0.05);
    } else {
      el.textContent = 'AGENTE LOCAL: DESCONECTADO';
      el.classList.add('agent-off'); el.classList.remove('agent-on');
      btn.textContent = 'CONECTAR';
      pushLog('warn', 'Agente local desconectado');
      beep(440, 0.1, 'sawtooth', 0.04);
    }
    // TODO: aquí ir y abrir WebSocket o fetch contra el backend real cuando exista.
  });
  // Settings → toggle TTS (silencio / voz)
  $('#settings-btn').addEventListener('click', () => {
    const enabled = TTS.toggle();
    beep(enabled ? 1320 : 220, 0.08, 'square', 0.04);
    pushLog('sys', enabled ? 'Voz de J.A.R.V.I.S. activada' : 'Voz de J.A.R.V.I.S. silenciada');
    $('#settings-btn').style.color = enabled ? 'var(--cy)' : 'var(--orange)';
    $('#settings-btn').title = enabled ? 'Voz activa (click para silenciar)' : 'Voz silenciada (click para activar)';
  });
  // Mobile toggles
  $$('.mobile-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = $('#' + btn.dataset.target);
      if (!target) return;
      const open = target.classList.toggle('open');
      btn.classList.toggle('open', open);
      btn.textContent = (open ? '▲ ' : '▼ ') + btn.textContent.replace(/^[▲▼]\s*/, '');
    });
  });

  // First user gesture: ensure audio
  document.addEventListener('click', () => ensureAudio(), { once: true });
}

/* ============================================================
   13. INIT
   ============================================================ */
async function init() {
  // start frame monitor cuanto antes para tener historial de jank
  Device.startFrameMonitor();
  await Device.initBattery();

  // boot
  runBootSequence();

  // builds
  Sphere.build();
  Sphere.updateStatusUI();
  buildCores();
  buildQuickCmds();
  renderCmdHistory();
  renderDeviceInfo();

  // initial seed network history
  for (let i = 0; i < CONFIG.network.history; i++) {
    NetGraph.push(rand(20, 70), rand(5, 30));
  }

  // start render loops
  Sphere.render();
  Particles.init();
  Radar.init();

  // metric loops — datos REALES
  await updateMetricTargets();
  renderMetrics();
  setInterval(() => { updateMetricTargets(); }, CONFIG.metrics.updateMs);
  setInterval(() => { lerpStateMetrics(); renderMetrics(); }, 60);
  setInterval(renderDeviceInfo, 5000);

  // network update loop (datos reales)
  setInterval(() => {
    NetGraph.push(STATE.metrics.netDl, Math.min(60, (STATE.metrics.netRtt || 0) / 4));
    NetGraph.draw();
  }, CONFIG.network.updateMs);
  NetGraph.draw();

  // logs
  startLogLoop();

  // clock
  updateClock();
  setInterval(updateClock, 1000);

  // glitch
  scheduleGlitch();

  // events
  bindEvents();
  bindTabsBridge();

  // Restaurar historial de chat compartido (otra pestaña puede haber escrito)
  try {
    const sess = window.TabsBridge?.Session.load() || {};
    if (Array.isArray(sess.chatHistory) && sess.chatHistory.length && !STATE.chatHistory.length) {
      // sólo si esta pestaña recién abre y no tiene historial propio
      sess.chatHistory.slice(-20).forEach(m => {
        if (m.role === 'user') {
          STATE.chatHistory.push(m);
          const el = document.createElement('div');
          el.className = 'msg user';
          el.innerHTML = `<span class="msg-pre">TÚ</span><span class="msg-text"></span><span class="msg-time">${m.time||''}</span>`;
          el.querySelector('.msg-text').textContent = m.text;
          $('#chat-history').appendChild(el);
        } else {
          STATE.chatHistory.push(m);
          const el = document.createElement('div');
          el.className = 'msg jarvis';
          el.innerHTML = `<span class="msg-pre">J.A.R.V.I.S.</span><span class="msg-text"></span><span class="msg-time">${m.time||''}</span>`;
          el.querySelector('.msg-text').textContent = m.text;
          $('#chat-history').appendChild(el);
        }
      });
      scrollChat();
      pushLog('info', '🔄 Historial restaurado de sesión compartida (' + STATE.chatHistory.length + ' mensajes)');
    }
  } catch (e) { /* ignore */ }

  // Persistir en sesión cuando hay cambios — debounced
  let persistTimer = null;
  const persistSession = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try { window.TabsBridge?.Session.patch({ chatHistory: STATE.chatHistory.slice(-30) }); } catch {}
    }, 1500);
  };
  // Hook simple: cada vez que se llama addUserMessage o addJarvisMessage queda en STATE.chatHistory.
  // Le añadimos un wrapper a setInterval para persistir.
  setInterval(persistSession, 5000);

  // online / offline detection
  window.addEventListener('online',  () => { pushLog('sys', 'Conexión a red restablecida'); renderDeviceInfo(); });
  window.addEventListener('offline', () => { pushLog('warn', 'Conexión a red perdida'); renderDeviceInfo(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
