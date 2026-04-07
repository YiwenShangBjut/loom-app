import { Texture } from 'pixi.js';

/**
 * Steel wire highlight overlay:
 * - Strong, narrow specular streaks
 * - Subtle cylindrical highlight profile
 * - Tileable along U so it repeats along rope length
 */
const STRIP_W = 128;
const STRIP_H = 32;

let cachedSteelSheen: Texture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawSteelSheen(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, STRIP_W, STRIP_H);

  // 更窄的镜面高光芯 + 边缘迅速回落，读作坚硬圆柱金属
  const vg = ctx.createLinearGradient(0, 0, 0, STRIP_H);
  vg.addColorStop(0, 'rgba(255,255,255,0)');
  vg.addColorStop(0.38, 'rgba(255,255,255,0.06)');
  vg.addColorStop(0.46, 'rgba(255,255,255,0.38)');
  vg.addColorStop(0.5, 'rgba(255,255,255,0.92)');
  vg.addColorStop(0.54, 'rgba(255,255,255,0.38)');
  vg.addColorStop(0.62, 'rgba(255,255,255,0.06)');
  vg.addColorStop(1, 'rgba(255,255,255,0)');

  // Along-U: 更利的周期性亮条 + 细抖动
  for (let x = 0; x < STRIP_W; x++) {
    const t = x / STRIP_W;
    const streak = Math.max(0, Math.sin(t * Math.PI * 2 * 8));
    const micro = 0.5 + 0.5 * Math.sin((t * 2.7 + 0.17) * Math.PI * 2);
    const a = 0.26 * streak * streak * streak + 0.1 * micro;
    ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = vg;
    ctx.fillRect(x, 0, 1, STRIP_H);
  }
  ctx.globalAlpha = 1;

  // 锐利轴向高光细线（可平铺）
  ctx.strokeStyle = 'rgba(255,255,255,0.48)';
  ctx.lineWidth = 1;
  for (let x = 1; x < STRIP_W; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, STRIP_H);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 0.5;
  for (let x = 5; x < STRIP_W; x += 12) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, STRIP_H);
    ctx.stroke();
  }
}

export function getSteelSheenTexture(): Texture {
  if (cachedSteelSheen) return cachedSteelSheen;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawSteelSheen(ctx);
  cachedSteelSheen = Texture.from({ resource: c });
  if (cachedSteelSheen.source.style) cachedSteelSheen.source.style.addressMode = 'repeat';
  return cachedSteelSheen;
}

export const STEEL_STRIP_WIDTH = STRIP_W;
export const STEEL_STRIP_HEIGHT = STRIP_H;

