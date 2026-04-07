import { Texture } from 'pixi.js';

/**
 * 发光纹理：中心不透明，向两侧渐变到透明。
 * 用于 BlurFilter 羽化效果。
 *
 * 验证配置是否生效：将 forceShow 设为 true，edgeAlpha 设为 0.8，
 * 在 Create 页画一条线并 commit，刷新。应看到明显发光。
 */
const W = 32;
const H = 128;

/** 可调参数：修改后刷新页面即可生效 */
export const HALO_STRIP_CONFIG = {
  /** 左/右边缘的 alpha，0=完全透明，1=不透明 */
  edgeAlpha: 1,
  /** 过渡区起点/终点的 alpha */
  transitionAlpha: 1,
  /** 进入不透明区的位置 0~1，越小中心越宽 */
  opaqueStart: 0.05,
  /** 不透明区结束位置 0~1，越大中心越宽 */
  opaqueEnd: 1,
  /** 中心不透明度 */
  centerAlpha: 1,
  /** 调试：true 时强制显示发光（无视 softness），用于确认配置是否生效 */
  forceShow: false,
};

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawHaloStrip(ctx: CanvasRenderingContext2D): void {
  const c = HALO_STRIP_CONFIG;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `rgba(255,255,255,${c.edgeAlpha})`);
  g.addColorStop(0.04, `rgba(255,255,255,${c.transitionAlpha})`);
  g.addColorStop(c.opaqueStart, `rgba(255,255,255,${c.centerAlpha})`);
  g.addColorStop(0.5, `rgba(255,255,255,${c.centerAlpha})`);
  g.addColorStop(c.opaqueEnd, `rgba(255,255,255,${c.centerAlpha})`);
  g.addColorStop(0.96, `rgba(255,255,255,${c.transitionAlpha})`);
  g.addColorStop(1, `rgba(255,255,255,${c.edgeAlpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

let cachedHaloStripTexture: Texture | null = null;

/**
 * 条带纹理缓存：避免 RopeRenderer 每帧为光晕/阴影创建 Canvas 与 Texture（GC 与上传开销大）。
 * 修改 HALO_STRIP_CONFIG 后需调用 {@link invalidateCachedHaloStripTexture} 再刷新页面。
 */
export function getHaloStripTexture(): Texture {
  if (cachedHaloStripTexture) return cachedHaloStripTexture;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D not available');
  drawHaloStrip(ctx);
  const tex = Texture.from({ resource: canvas });
  if (tex.source?.style) tex.source.style.addressMode = 'repeat';
  cachedHaloStripTexture = tex;
  return tex;
}

export function invalidateCachedHaloStripTexture(): void {
  if (cachedHaloStripTexture) {
    cachedHaloStripTexture.destroy(true);
    cachedHaloStripTexture = null;
  }
}
