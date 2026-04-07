import { Texture } from 'pixi.js';

/**
 * Silk appearance:
 * - Very smooth filament surface (almost no visible fibre structure)
 * - Subtle continuous sheen along rope direction (U)
 * - Tileable along U for repeat on RopeGeometry
 */
const STRIP_W = 256; // more room for a soft moving highlight pattern
const STRIP_H = 32;

let cachedBase: Texture | null = null;
let cachedSheen: Texture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Smooth base (no visible fibres). */
function drawSilkBase(ctx: CanvasRenderingContext2D): void {
  // flat white (tint will colour it)
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  // micro-variation to avoid banding (non-directional, extremely subtle)
  ctx.fillStyle = 'rgba(0,0,0,0.02)';
  for (let i = 0; i < 220; i++) {
    const x = (i * 37.7) % STRIP_W;
    const y = (i * 11.3 + 7) % STRIP_H;
    ctx.fillRect(x, y, 1, 1);
  }
}

/**
 * Sheen overlay:
 * - Bright highlight streaks that vary along U so it feels glossy/continuous.
 * - Kept soft to avoid looking like a hard plastic.
 */
function drawSilkSheen(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, STRIP_W, STRIP_H);

  // Vertical highlight profile (center brighter, edges fade)
  const vg = ctx.createLinearGradient(0, 0, 0, STRIP_H);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(0.30, 'rgba(255,255,255,0.16)');
  vg.addColorStop(0.46, 'rgba(255,255,255,0.42)');
  vg.addColorStop(0.50, 'rgba(255,255,255,0.55)');
  vg.addColorStop(0.54, 'rgba(255,255,255,0.42)');
  vg.addColorStop(0.70, 'rgba(255,255,255,0.16)');
  vg.addColorStop(1, 'rgba(255,255,255,0)');

  // Along-U modulation: soft sine bands (tileable because STRIP_W is period)
  for (let x = 0; x < STRIP_W; x++) {
    const t = x / STRIP_W;
    const w1 = 0.55 + 0.45 * Math.sin(t * Math.PI * 2);
    const w2 = 0.55 + 0.45 * Math.sin((t * 2 + 0.15) * Math.PI * 2);
    const a = 0.16 * w1 + 0.10 * w2; // 0..~0.26 (stronger silk sheen)
    ctx.globalAlpha = a;
    ctx.fillStyle = vg;
    ctx.fillRect(x, 0, 1, STRIP_H);
  }

  ctx.globalAlpha = 1;
}

export function getSilkBaseTexture(): Texture {
  if (cachedBase) return cachedBase;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawSilkBase(ctx);
  cachedBase = Texture.from({ resource: c });
  if (cachedBase.source.style) cachedBase.source.style.addressMode = 'repeat';
  return cachedBase;
}

export function getSilkSheenTexture(): Texture {
  if (cachedSheen) return cachedSheen;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawSilkSheen(ctx);
  cachedSheen = Texture.from({ resource: c });
  if (cachedSheen.source.style) cachedSheen.source.style.addressMode = 'repeat';
  return cachedSheen;
}

export const SILK_STRIP_WIDTH = STRIP_W;
export const SILK_STRIP_HEIGHT = STRIP_H;

