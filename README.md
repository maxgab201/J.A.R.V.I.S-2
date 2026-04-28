# J.A.R.V.I.S. Mark VII Interface

HUD holográfico estilo Iron Man — vanilla HTML/CSS/JS + Vercel Serverless Functions con Gemini 2.5 Flash.

## Características

### Interfaz
- HUD visual estilo Tony Stark (esfera 3D animada, radar, gráficos en tiempo real, glitch RGB, scanlines).
- Métricas reales del dispositivo: cores, RAM, batería, red, latencia, almacenamiento.

### IA y voz
- **Chat real con cadena de fallback**: NVIDIA Nemotron-3-Super-120B → Gemini → Mistral → OpenRouter (Llama 3.3) → Hugging Face.
- **TTS** vía Gemini 2.5 Flash Preview TTS (voz neural Charon) + fallback Web Speech API.
- **STT** vía MediaRecorder + Gemini transcription (funciona en Brave, donde `webkitSpeechRecognition` está bloqueado).

### NUEVO — Interacción con otras pestañas

#### A. Pestañas del MISMO sitio (PC + móvil) — sin extensión
- **Sesión compartida** (`localStorage`): el historial de chat y los settings se sincronizan entre todas las pestañas de J.A.R.V.I.S. abiertas en el mismo navegador.
- **Chat entre pestañas** (`BroadcastChannel`): J.A.R.V.I.S. puede enviar mensajes a las otras pestañas, y vos también clicando en una pestaña par del panel.
- **Panel "PESTAÑAS CONECTADAS"**: muestra cuántas pestañas pares tenés abiertas y permite saludarlas.

JARVIS lo usa con la etiqueta `[PEERS:msg:<texto>]` que el cliente intercepta.

#### B. OTRAS pestañas del navegador (sólo PC) — requiere extensión
La extensión `J.A.R.V.I.S. Tab Controller` (Manifest V3, Chrome/Edge/Brave) le da a J.A.R.V.I.S. capacidad de:
- Listar todas las pestañas abiertas
- Cambiar a una pestaña, abrirla o cerrarla
- Leer el contenido de una pestaña (resumen o texto completo)
- Pausar / reproducir videos (YouTube, Twitch, etc.)
- Hacer scroll, recargar, ir adelante/atrás, ajustar volumen

JARVIS las invoca con `[TABS:list]`, `[TABS:switch:<id>]`, `[TABS:read:<id>]`, `[TABS:control:<id>:pause]`, etc.
El parser ejecuta y le devuelve el resultado al modelo en un follow-up para que elabore.

#### Instalación de la extensión (modo desarrollador, 30 segundos)
1. Descargá `extension/jarvis-tab-controller.zip` o cliqueá **INSTALAR** en el panel.
2. Descomprimí en cualquier carpeta.
3. Abrí `chrome://extensions` (o `edge://extensions` / `brave://extensions`).
4. Activá **Modo desarrollador**.
5. **Cargar descomprimida** → seleccioná la carpeta.
6. Recargá la web — el indicador "EXTENSIÓN" pasa a verde.

> En móvil esta función no está disponible (los navegadores móviles no soportan extensiones que controlen pestañas, salvo Kiwi/Yandex en Android donde sí cargan esta extensión).

## Estructura

```
/
├── index.html              # markup HUD
├── style.css               # estilos
├── script.js               # lógica principal (vanilla)
├── tabs-bridge.js          # módulo cross-tab (BroadcastChannel + extensión)
├── system-profile.js       # perfil de hardware editable
├── api/
│   ├── agent.js            # serverless: chat (multi-proveedor)
│   ├── transcribe.js       # serverless: STT con Gemini
│   └── tts.js              # serverless: TTS con Gemini
├── extension/              # extensión Chrome/Edge MV3
│   ├── manifest.json
│   ├── background.js       # service worker (control real de tabs)
│   ├── content-bridge.js   # bridge inyectado en la web JARVIS
│   ├── popup.html
│   ├── icons/
│   └── jarvis-tab-controller.zip
├── dev-server.js           # servidor local
├── package.json
├── vercel.json
└── .env                    # variables de entorno
```

## Variables de entorno

```bash
NVIDIA_API_KEY=nvapi-...      # NVIDIA Nemotron (primer proveedor)
GEMINI_API_KEY=...            # principal
GEMINI_API_KEY_2=...          # secundaria (mismo proveedor, otra cuota)
MISTRAL_API_KEY=...
OPENROUTER_API_KEY=...
HUGGINGFACE_API_KEY=...
GEMINI_TTS_MODEL=gemini-2.5-flash-preview-tts   # opcional
GEMINI_TTS_VOICE=Charon                         # opcional
```

## Desarrollo local

```bash
node dev-server.js
# luego http://localhost:3000
```

## Deploy en Vercel

1. Subí el repo a Vercel.
2. En **Settings → Environment Variables** agregá las claves de arriba.
3. Redeploy.

Vercel detecta automáticamente:
- `index.html` como página principal.
- `api/*.js` como Serverless Functions.
- `extension/jarvis-tab-controller.zip` se sirve como descarga directa.

## Compatibilidad

| Navegador | Web | Extensión |
|---|---|---|
| Chrome / Edge / Brave (PC) | ✅ Todo | ✅ Sí |
| Firefox (PC) | ✅ Todo | ⚠️ No (la extensión usa MV3 chrome.*) |
| Safari (PC/Mac) | ✅ Todo | ❌ No |
| Chrome / Brave / Kiwi (Android) | ✅ Todo (sin función B) | ⚠️ Sólo Kiwi/Yandex |
| Safari (iOS) | ✅ Todo (sin función B) | ❌ No |

## Notas técnicas

- `gemini-2.0-flash` (texto) y `gemini-2.5-flash` (multimodal/STT) por balance velocidad/calidad/cuota.
- El historial completo del chat (últimos 12 turnos) se envía al modelo en cada llamada.
- System prompt en español rioplatense para mantener el tono JARVIS.
- Métricas reales vía: `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `performance.memory`, `navigator.connection`, `navigator.getBattery()`, `navigator.storage.estimate()`.
- La carga de CPU se estima vía detección de jank en `requestAnimationFrame`.
- Cross-tab: `BroadcastChannel` (Safari iOS antiguos caen al fallback `localStorage` events).
- Extensión: comunicación web ↔ extensión vía `window.postMessage` (puente de content script) ↔ `chrome.runtime.sendMessage` (service worker).
