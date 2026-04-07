import { Texture } from 'pixi.js';

/**
 * Thread appearance:
 * - Tightly spun fine fibres
 * - Subtle linear structure along rope direction (U)
 * - Vertical inner shading (strip V) for round cross-section
 * - Matte / low-sheen
 * - Tileable along U
 */
const STRIP_W = 128;
const STRIP_H = 32;

let cachedThread: Texture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawThreadStrip(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  // 截面内侧暗部：上下缘略压暗，中间受光，增强圆线体积（适度，避免发灰）
  const vol = ctx.createLinearGradient(0, 0, 0, STRIP_H);
  vol.addColorStop(0, 'rgba(0,0,0,0.20)');
  vol.addColorStop(0.28, 'rgba(0,0,0,0.045)');
  vol.addColorStop(0.5, 'rgba(0,0,0,0)');
  vol.addColorStop(0.72, 'rgba(0,0,0,0.045)');
  vol.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = vol;
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  // fine spun fibres: many thin, slightly slanted strokes (directional but subtle)
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 0.6;
  for (let x = -16; x < STRIP_W + 16; x += 4) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 10, STRIP_H);
    ctx.stroke();
  }

  // tight twist grooves: faint periodic bands along U
  for (let x = 0; x < STRIP_W; x++) {
    const t = x / STRIP_W;
    const a = 0.06 + 0.06 * Math.sin(t * Math.PI * 2 * 6);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(x, 0, 1, STRIP_H);
  }
  ctx.globalAlpha = 1;

  // reduce “gloss”: tiny noise
  ctx.fillStyle = 'rgba(0,0,0,0.02)';
  for (let i = 0; i < 160; i++) {
    const x = (i * 19.7) % STRIP_W;
    const y = (i * 9.1 + 3) % STRIP_H;
    ctx.fillRect(x, y, 1, 1);
  }
}

export function getThreadRopeTexture(): Texture {
  if (cachedThread) return cachedThread;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawThreadStrip(ctx);
  cachedThread = Texture.from({ resource: c });
  if (cachedThread.source?.style) cachedThread.source.style.addressMode = 'repeat';
  return cachedThread;
}

export const THREAD_STRIP_WIDTH = STRIP_W;
export const THREAD_STRIP_HEIGHT = STRIP_H;

