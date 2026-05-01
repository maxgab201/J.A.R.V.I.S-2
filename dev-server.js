/**
 * dev-server.js — servidor de desarrollo local sin dependencias.
 * Sirve los archivos estáticos y enruta /api/* a las funciones de Vercel.
 * Carga .env automáticamente.
 *
 * Uso:  node dev-server.js   (luego abrí http://localhost:3000)
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTS = (process.env.PORTS || process.env.PORT || '3000,8001').split(',').map(p => Number(p.trim())).filter(Boolean);

// --- cargar .env (parser mínimo, sin dotenv) ---
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
  console.log('[dev] .env cargado');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.mjs' : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg' : 'image/svg+xml',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico' : 'image/x-icon',
  '.txt' : 'text/plain; charset=utf-8',
  '.md'  : 'text/plain; charset=utf-8',
};

// Cache dinámico para handlers de /api
const handlerCache = new Map();
async function loadHandler(file) {
  if (!handlerCache.has(file)) {
    // import dinámico para que cualquier cambio requiera reinicio (simple)
    const mod = await import(pathToFileURL(file).href);
    handlerCache.set(file, mod.default);
  }
  return handlerCache.get(file);
}

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ---- API routes ----
    if (pathname.startsWith('/api/')) {
      const name = pathname.replace(/^\/api\//, '').replace(/\.js$/, '');
      if (!/^[a-z0-9_-]+$/i.test(name)) return sendJson(res, 404, { error: 'No encontrado' });
      const file = join(__dirname, 'api', `${name}.js`);
      if (!existsSync(file)) return sendJson(res, 404, { error: `API ${name} no existe` });

      // adaptar res al estilo Vercel
      res.status = (code) => { res.statusCode = code; return res; };
      res.json   = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };

      // pre-parsear body JSON si corresponde
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        let raw = '';
        const limitMb = 10;
        let bytes = 0;
        await new Promise((resolve, reject) => {
          req.on('data', (c) => {
            bytes += c.length;
            if (bytes > limitMb * 1024 * 1024) { reject(new Error('Body demasiado grande')); req.destroy(); return; }
            raw += c;
          });
          req.on('end', resolve);
          req.on('error', reject);
        }).catch(err => { sendJson(res, 413, { error: err.message }); throw err; });
        try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      }

      const handler = await loadHandler(file);
      return handler(req, res);
    }

    // ---- Static files ----
    let safe = normalize(pathname).replace(/^\.\.+/g, '').replace(/^\/+/, '');
    if (!safe) safe = 'index.html';
    const filePath = join(__dirname, safe);
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) {
        const idx = join(filePath, 'index.html');
        const buf = await readFile(idx);
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(buf);
      }
      const buf = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(buf);
    } catch {
      // SPA fallback → index.html
      try {
        const buf = await readFile(join(__dirname, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(buf);
      } catch {
        res.writeHead(404).end('Not found');
      }
    }
  } catch (e) {
    console.error('[dev] error', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
  }
}

for (const port of PORTS) {
  const s = http.createServer(handle);
  s.listen(port, '0.0.0.0', () => {
    console.log(`[dev] J.A.R.V.I.S. corriendo en http://localhost:${port}`);
  });
}
console.log(`[dev] API: /api/agent  /api/transcribe  /api/tts`);
if (!process.env.GEMINI_API_KEY) console.warn('[dev] ⚠ GEMINI_API_KEY no encontrada en .env');
