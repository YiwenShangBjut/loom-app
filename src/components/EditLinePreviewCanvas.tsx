import { useEffect, useRef } from 'react';
import { Application, Container } from 'pixi.js';
import { RopeRenderer } from '../canvas/RopeRenderer';
import type { Point, RenderThread } from '../physics/types';
import type { MaterialTextureId } from '../rendering/materialTextures';

const PREVIEW_W = 240;
const PREVIEW_H = 80;

function hexToTint(hex: string): number {
  const s = hex.replace(/^#/, '');
  if (s.length !== 6) return 0xd8d4cc;
  return parseInt(s, 16);
}

function scalePointsToFit(points: Point[], width: number, height: number): { points: Point[]; scale: number } {
  if (points.length < 2) return { points, scale: 1 };
  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const pad = 12;
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  const ox = pad + (width - pad * 2 - w * scale) / 2;
  const oy = pad + (height - pad * 2 - h * scale) / 2;
  return {
    points: points.map((p) => ({
      x: ox + (p.x - minX) * scale,
      y: oy + (p.y - minY) * scale,
    })),
    scale,
  };
}

export function EditLinePreviewCanvas(props: {
  points: Point[];
  textureId: MaterialTextureId;
  strokeStyle: string;
  /** 与主工程一致：起点 `strokeStyle` → 终点；未传或与起点相同时为单色 */
  gradientStrokeStyle?: string;
  lineWidth: number;
  opacity01: number;
  /** 0..1; lower = softer */
  stiffness01?: number;
}) {
  const { points, textureId, strokeStyle, gradientStrokeStyle, lineWidth, opacity01, stiffness01 = 0.6 } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const ropeRef = useRef<RopeRenderer | null>(null);

  useEffect(() => {
    return () => {
      const app = appRef.current;
      if (app?.canvas?.parentNode) app.canvas.parentNode.removeChild(app.canvas as Node);
      app?.destroy();
      appRef.current = null;
      ropeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (points.length < 2) return;
    const el = containerRef.current;
    if (!el) return;

    const gradTint =
      gradientStrokeStyle && strokeStyle.toLowerCase() !== gradientStrokeStyle.toLowerCase()
        ? hexToTint(gradientStrokeStyle)
        : undefined;

    const buildThread = (scaled: Point[]): RenderThread => ({
      points: scaled,
      isActive: false,
      underCrossings: [],
      bridges: [],
      textureId,
      lineWidth,
      color: hexToTint(strokeStyle),
      gradientColor: gradTint,
      opacity: Math.max(0.1, Math.min(1, opacity01)),
      stiffness: stiffness01,
    });

    if (ropeRef.current && appRef.current) {
      const { points: scaled, scale: fitScale } = scalePointsToFit(points, PREVIEW_W, PREVIEW_H);
      ropeRef.current.update(
        [
          {
            ...buildThread(scaled),
            lineWidth: lineWidth * fitScale * 0.8,
          },
        ],
        undefined,
        1,
        PREVIEW_W
      );
      return;
    }

    let mounted = true;
    (async () => {
      const app = new Application();
      await app.init({
        width: PREVIEW_W,
        height: PREVIEW_H,
        background: 0xffffff,
        antialias: true,
        resolution: 1,
      });
      if (!mounted || !containerRef.current) {
        app.destroy();
        return;
      }
      const content = new Container();
      app.stage.addChild(content);
      const rope = new RopeRenderer(app, content);
      appRef.current = app;
      ropeRef.current = rope;
      containerRef.current.appendChild(app.canvas as HTMLCanvasElement);
      const { points: scaled, scale: fitScale } = scalePointsToFit(points, PREVIEW_W, PREVIEW_H);
      rope.update(
        [
          {
            ...buildThread(scaled),
            lineWidth: lineWidth * fitScale * 0.8,
          },
        ],
        undefined,
        1,
        PREVIEW_W
      );
    })();
    return () => {
      mounted = false;
    };
  }, [points, textureId, strokeStyle, gradientStrokeStyle, lineWidth, opacity01, stiffness01]);

  return <div ref={containerRef} className="try-edit-line-preview-inner" />;
}
