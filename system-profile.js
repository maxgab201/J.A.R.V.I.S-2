/**
 * system-profile.js — Perfil real del sistema del usuario
 * ──────────────────────────────────────────────────────────
 * Los navegadores LIMITAN las APIs de detección por privacidad:
 *   - navigator.deviceMemory está topado a 8 GB máximo (W3C spec)
 *   - No hay forma de leer la GPU ni la VRAM
 *   - No hay forma de leer la velocidad real de la RAM
 *
 * Editá este archivo con TUS specs reales y el HUD las muestra correctamente.
 * Además, J.A.R.V.I.S. recibe esta info en el prompt y puede hablarte con
 * conocimiento exacto de tu hardware.
 *
 * Definí `null` en cualquier campo que NO quieras forzar (el HUD usará
 * lo que detecte el navegador automáticamente).
 */
window.SYSTEM_PROFILE = {
  cpu: {
    name: 'Intel Core Ultra 9 275HX',
    cores: 24,                    // núcleos lógicos reales
    threads: 24,
    boostClockGHz: 5.4,
    architecture: 'Arrow Lake-HX',
  },
  gpu: {
    name: 'NVIDIA GeForce RTX 5070 Ti Laptop',
    vramGB: 12,
    vramType: 'GDDR7',
    architecture: 'Blackwell',
  },
  ram: {
    sizeGB: 32,
    type: 'DDR5',
    speedMTs: 6400,
  },
  storage: {
    note: 'SSD NVMe',             // texto libre, opcional
  },
  os: null,                       // null → autodetectar (Windows / Linux / macOS)
  user: {
    title: 'señor',               // cómo te dirige J.A.R.V.I.S. ('señor' / 'señora' / 'jefe' / etc.)
    name: 'Tony Stark',           // null para no usar nombre
  },
};
