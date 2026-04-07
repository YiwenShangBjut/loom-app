import type { LoomCanvasHandle } from './components/LoomCanvas';
import type { SavedCreation } from './savedCreation';
import { getCustomNamedThreadIndices } from './savedCreation';

export type StoryBubbleRenderItem = {
  name: string;
  nx: number;
  ny: number;
};

export function splitBubbleLines(name: string): string[] {
  return name.match(/.{1,20}/g) ?? [name];
}

export function collectStoryBubbleItems(
  loomHandle: LoomCanvasHandle | null,
  creation: SavedCreation,
): StoryBubbleRenderItem[] {
  if (!loomHandle) return [];
  const indices = getCustomNamedThreadIndices(creation);
  if (indices.length === 0) return [];
  const threadNames =
    creation.threadNames ??
    (Array.isArray(creation.threads) ? creation.threads.map((_, i) => `Line ${i + 1}`) : []);

  const out: StoryBubbleRenderItem[] = [];
  for (const idx of indices) {
    const pos = loomHandle.getThreadBubbleCanvasFraction(idx);
    if (!pos) continue;
    const name = threadNames[idx] ?? `Line ${idx + 1}`;
    out.push({ name, nx: pos.x, ny: pos.y });
  }
  return out;
}

/**
 * Draw story labels on top of the loom canvas (same as Admin export thumbnails).
 * `baseCanvas` 应为 LoomCanvasHandle.getExportSnapshotCanvas() 的结果；勿用 WebGL 视图 canvas，否则易全黑。
 */
export function composeCanvasWithStoryBubbles(
  baseCanvas: HTMLCanvasElement,
  loomHandle: LoomCanvasHandle | null,
  creation: SavedCreation,
): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = baseCanvas.width;
  out.height = baseCanvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return baseCanvas;
  ctx.drawImage(baseCanvas, 0, 0);

  const items = collectStoryBubbleItems(loomHandle, creation);
  if (items.length === 0) return out;

  const drawRoundedRect = (x: number, y: number, w: number, h: number, r: number) => {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  };

  const scale = Math.max(0.75, Math.min(1.3, out.width / 720));
  const fontSize = 10 * scale;
  const lineHeight = 12.5 * scale;
  const padX = 8 * scale;
  const padY = 4 * scale;
  const maxChars = 20;
  const maxWidth = maxChars * fontSize * 0.62 + padX * 2;
  const minMargin = 4 * scale;

  ctx.font = `500 ${fontSize}px Inter, "Noto Sans", sans-serif`;
  ctx.textBaseline = 'top';

  for (const item of items) {
    const lines = splitBubbleLines(item.name);
    const maxLineLen = lines.reduce((m, line) => Math.max(m, line.length), 0);
    const bubbleW = Math.min(maxWidth, maxLineLen * fontSize * 0.62 + padX * 2);
    const bubbleH = Math.min(72 * scale, lines.length * lineHeight + padY * 2);
    const halfW = bubbleW / 2;
    const halfH = bubbleH / 2;

    const rawX = item.nx * out.width;
    const rawY = item.ny * out.height;
    const cx = Math.max(halfW + minMargin, Math.min(out.width - halfW - minMargin, rawX));
    const cy = Math.max(halfH + minMargin, Math.min(out.height - halfH - minMargin, rawY));
    const x = cx - halfW;
    const y = cy - halfH;

    ctx.fillStyle = 'rgba(128, 64, 128, 0.65)';
    drawRoundedRect(x, y, bubbleW, bubbleH, 6 * scale);

    ctx.fillStyle = '#ffffff';
    let textY = y + padY;
    for (const line of lines) {
      ctx.fillText(line, x + padX, textY, bubbleW - padX * 2);
      textY += lineHeight;
    }
  }
  return out;
}

export function nextExportFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
