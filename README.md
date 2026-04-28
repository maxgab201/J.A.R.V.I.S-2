# J.A.R.V.I.S. Mark VII Interface

HUD holográfico estilo Iron Man — vanilla HTML/CSS/JS + Vercel Serverless Functions con Gemini 2.5 Flash.

## Características

- Interfaz visual idéntica al HUD de Tony Stark (esfera 3D animada, radar, gráficos en tiempo real, glitch RGB, scanlines).
- **Chat real con Gemini 2.5 Flash** (multi-turn, con memoria de la conversación).
- **TTS** vía Web Speech API (`speechSynthesis`) — gratis, soporta español.
- **STT** vía MediaRecorder + Gemini transcription — funciona incluso en Brave (donde `webkitSpeechRecognition` está bloqueado).
- **Métricas reales** del dispositivo: cores, RAM, batería, red, latencia, almacenamiento — todo leído del navegador en tiempo real.

## Estructura

```
/
├── index.html              # markup HUD
├── style.css               # estilos
├── script.js               # toda la lógica (vanilla)
├── api/
│   ├── agent.js            # serverless: chat con Gemini
│   └── transcribe.js       # serverless: STT con Gemini
├── dev-server.js           # servidor local (sin dependencias)
├── package.json            # type:module + scripts
├── vercel.json             # config Vercel
└── .env                    # GEMINI_API_KEY (no commitear)
```

## Desarrollo local

```bash
node dev-server.js
# luego http://localhost:3000
```

El servidor lee `.env` automáticamente y enruta `/api/*` a las funciones serverless.
Requiere Node 18+ (para `fetch` nativo).

## Deploy en Vercel

1. Subí el repo a Vercel (`vercel deploy` o desde el dashboard).
2. En Vercel → Settings → Environment Variables, agregá:
   - `GEMINI_API_KEY` = tu clave de https://aistudio.google.com/apikey
3. Redeploy. Listo.

Vercel detecta automáticamente:
- `index.html` como página principal.
- `api/*.js` como Serverless Functions.

## Consideraciones por navegador

- **Chrome / Edge**: funciona todo out-of-the-box.
- **Brave**: TTS funciona; el reconocimiento de voz nativo está bloqueado por privacidad — la app usa MediaRecorder + Gemini como fallback automático (no requiere configuración).
- **Firefox**: TTS funciona. STT vía MediaRecorder funciona.
- **Safari**: TTS funciona. STT funciona en Safari 14.1+.

## Notas técnicas

- `gemini-2.5-flash` elegido por balance velocidad / calidad / cuota gratuita generosa.
- El historial completo del chat se envía al modelo en cada llamada (multi-turn real).
- System prompt en español rioplatense para mantener el tono JARVIS.
- Las métricas del dispositivo se leen vía: `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `performance.memory`, `navigator.connection`, `navigator.getBattery()`, `navigator.storage.estimate()`.
- La carga de CPU se estima vía detección de jank en `requestAnimationFrame`.
