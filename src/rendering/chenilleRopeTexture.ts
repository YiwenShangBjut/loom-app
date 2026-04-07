import { Texture } from 'pixi.js';
import { MATERIAL_TEXTURE_PRESETS } from './materialTextures';

/**
 * Chenille yarn appearance:
 * - Non-directional plush surface (no fibre flow)
 * - Looks like a soft cylindrical tube (stronger vertical shading)
 * - Tileable along rope direction (U repeat)
 */
const STRIP_W = 128;
const STRIP_H = 48;

let cachedTube: Texture | null = null;
let cachedPlush: Texture | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Reuse material preset inner-shadow params to shape chenille tube volume. */
function drawTubeShading(ctx: CanvasRenderingContext2D, strengthScale = 1): void {
  const shadow = MATERIAL_TEXTURE_PRESETS.chenille.innerShadow;
  const s = Math.max(0, Math.min(1, shadow.strength * strengthScale));
  if (s <= 0) return;

  const edgeOuterStop = Math.max(0, Math.min(0.5, shadow.edgeOuterStop));
  const edgeInnerStop = Math.max(edgeOuterStop, Math.min(0.5, shadow.edgeInnerStop));
  const highlightOuterStop = Math.max(0, Math.min(0.5, shadow.highlightOuterStop));

  const edge = ctx.createLinearGradient(0, 0, 0, STRIP_H);
  edge.addColorStop(edgeOuterStop, `rgba(0,0,0,${shadow.edgeAlpha * s})`);
  edge.addColorStop(edgeInnerStop, `rgba(0,0,0,${shadow.edgeInnerAlpha * s})`);
  edge.addColorStop(0.5, 'rgba(0,0,0,0)');
  edge.addColorStop(1 - edgeInnerStop, `rgba(0,0,0,${shadow.edgeInnerAlpha * s})`);
  edge.addColorStop(1 - edgeOuterStop, `rgba(0,0,0,${shadow.edgeAlpha * s})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  const midHighlight = ctx.createLinearGradient(0, 0, 0, STRIP_H);
  midHighlight.addColorStop(0, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(0.5, `rgba(255,255,255,${shadow.highlightAlpha * s})`);
  midHighlight.addColorStop(1 - highlightOuterStop, 'rgba(255,255,255,0)');
  midHighlight.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = midHighlight;
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);
}

// Keep the function name for reference, but mark it as intentionally unused.
void drawTubeShading;

/**
 * Plush fibres: dense, short, non-directional speckles.
 * Seamless in U by using modulo X.
 */
function drawPlush(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, STRIP_W, STRIP_H);
  // base very light fill (tint will colour it)
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);

  // dense short fibres / bumps
  for (let i = 0; i < 900; i++) {
    const x = (i * 13.7) % STRIP_W;
    const y = (i * 7.9 + 11) % STRIP_H;
    const r = 0.6 + ((i * 1.31) % 10) / 50; // ~0.6..0.8
    const a = 0.06 + ((i * 0.73) % 10) / 120; // ~0.06..0.14
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // occasional soft highlights (adds plush depth, still non-directional)
  for (let i = 0; i < 180; i++) {
    const x = (i * 29.3) % STRIP_W;
    const y = (i * 13.1 + 5) % STRIP_H;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc(x, y, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Keep chenille volume visible on the top layer too;
  // otherwise plush texture can hide most of the tube shading.
  drawTubeShading(ctx, 0.9);
}

export function getChenilleTubeTexture(): Texture {
  if (cachedTube) return cachedTube;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  ctx.clearRect(0, 0, STRIP_W, STRIP_H);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(0, 0, STRIP_W, STRIP_H);
  drawTubeShading(ctx);
  cachedTube = Texture.from({ resource: c });
  if (cachedTube.source.style) cachedTube.source.style.addressMode = 'repeat';
  return cachedTube;
}

export function getChenillePlushTexture(): Texture {
  if (cachedPlush) return cachedPlush;
  const c = makeCanvas(STRIP_W, STRIP_H);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawPlush(ctx);
  cachedPlush = Texture.from({ resource: c });
  if (cachedPlush.source.style) cachedPlush.source.style.addressMode = 'repeat';
  return cachedPlush;
}

export const CHENILLE_STRIP_WIDTH = STRIP_W;
export const CHENILLE_STRIP_HEIGHT = STRIP_H;

