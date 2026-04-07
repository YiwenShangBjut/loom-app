import { useEffect, useMemo, useRef, useState } from 'react';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function hsvToRgb(h: number, s: number, v: number) {
  const c = v * s;
  const hh = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0; let g = 0; let b = 0;
  if (hh < 60) { r = c; g = x; b = 0; }
  else if (hh < 120) { r = x; g = c; b = 0; }
  else if (hh < 180) { r = 0; g = c; b = x; }
  else if (hh < 240) { r = 0; g = x; b = c; }
  else if (hh < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const to = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export type PickedColour = {
  hex: string;
  rgb: { r: number; g: number; b: number };
  hsv: { h: number; s: number; v: number };
  /** 12 扇区索引（0..11），中心中性色时为 -1 */
  sectorIndex: number;
  /** 同心环索引（0..ringCount-1），中心中性色时为 -1 */
  ringIndex: number;
};

type ColourWheelPickerProps = {
  value: PickedColour;
  onChange: (picked: PickedColour) => void;
  onClose: () => void;
  gradient?: {
    value: PickedColour;
    onChange: (picked: PickedColour) => void;
  };
};

/**
 * 传统教学/画家色轮（分扇区 + 分同心环）：
 * - 12 个离散色相扇区（R, RO, O, YO, Y, YG, G, BG, B, BV, V, RV）
 * - 5 个同心环：径向亮度反转 —— 外圈深、内圈浅
 *   - 外圈：低 value、高 saturation → 深色、浓郁
 *   - 内圈：高 value、低 saturation → 浅色、粉彩感
 * - 中心为小中性白圆；边界线保持可见但柔和
 */
export function ColourWheelPicker({ value, onChange, onClose, gradient }: ColourWheelPickerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<'base' | 'gradient'>('base');

  const size = 220;
  const radius = size / 2;
  const innerNeutral = 0.18; // 中心中性色圆比例

  const sectors = useMemo(
    () => ([
      { label: 'R', h: 0 },
      { label: 'RO', h: 30 },
      { label: 'O', h: 60 },
      { label: 'YO', h: 90 },
      { label: 'Y', h: 120 },
      { label: 'YG', h: 150 },
      { label: 'G', h: 180 },
      { label: 'BG', h: 210 },
      { label: 'B', h: 240 },
      { label: 'BV', h: 270 },
      { label: 'V', h: 300 },
      { label: 'RV', h: 330 },
    ]),
    [],
  );

  /**
   * 径向映射：ri=0 为最内环（靠中心），ri=4 为最外环。
   * 外圈 = 低 V、高 S（深、浓）；内圈 = 高 V、低 S（浅、粉彩）。
   */
  const rings = useMemo(
    () => ([
      { s: 0.38, v: 0.94 }, // innermost: pale, washed
      { s: 0.52, v: 0.86 },
      { s: 0.70, v: 0.75 }, // middle: clearly coloured
      { s: 0.82, v: 0.62 },
      { s: 0.92, v: 0.50 }, // outermost: dark, deep, rich
    ]),
    [],
  );

  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D) => {
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(radius, radius);

      const ringCount = rings.length;
      const innerR = radius * innerNeutral;
      const ringW = (radius - innerR) / ringCount;

      // 用“扇区 × 环”逐格绘制（明确边界）
      for (let si = 0; si < sectors.length; si++) {
        const start = ((si * 30 - 90) * Math.PI) / 180; // 顶部为 R
        const end = (((si + 1) * 30 - 90) * Math.PI) / 180;
        for (let ri = 0; ri < ringCount; ri++) {
          const r0 = innerR + ri * ringW;
          const r1 = innerR + (ri + 1) * ringW;
          const { s, v } = rings[ri];
          const { r, g, b } = hsvToRgb(sectors[si].h, s, v);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.beginPath();
          ctx.arc(0, 0, r1, start, end);
          ctx.arc(0, 0, r0, end, start, true);
          ctx.closePath();
          ctx.fill();
        }
      }

      // 环边界线：柔和可见，不刺眼
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
      for (let ri = 1; ri < ringCount; ri++) {
        const rr = innerR + ri * ringW;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 扇区边界线：细线，保持结构可读
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = 1;
      for (let si = 0; si < sectors.length; si++) {
        const ang = ((si * 30 - 90) * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(innerR, 0);
        ctx.rotate(ang);
        ctx.moveTo(innerR, 0);
        ctx.lineTo(radius, 0);
        ctx.stroke();
        ctx.rotate(-ang);
      }

      // 外圈描边
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius - 1, 0, Math.PI * 2);
      ctx.stroke();

      // 中心中性色圆
      ctx.fillStyle = '#fafaf8';
      ctx.beginPath();
      ctx.arc(0, 0, innerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, innerR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    };
  }, [innerNeutral, radius, rings, sectors, size]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    draw(ctx);
  }, [draw]);

  function snappedPick(x: number, y: number): PickedColour | null {
    const dx = x - radius;
    const dy = y - radius;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r > radius) return null;

    const innerR = radius * innerNeutral;
    if (r <= innerR) {
      return {
        hex: '#ffffff',
        rgb: { r: 255, g: 255, b: 255 },
        hsv: { h: 0, s: 0, v: 1 },
        sectorIndex: -1,
        ringIndex: -1,
      };
    }

    let ang = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 在右侧
    ang = (ang + 450) % 360; // 0 在顶部，顺时针
    const sectorIndex = clamp(Math.floor(ang / 30), 0, 11);

    const ringCount = rings.length;
    const ringW = (radius - innerR) / ringCount;
    const ringIndex = clamp(Math.floor((r - innerR) / ringW), 0, ringCount - 1);

    const hsv = {
      h: sectors[sectorIndex].h,
      s: rings[ringIndex].s,
      v: rings[ringIndex].v,
    };
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    return { hex, rgb, hsv, sectorIndex, ringIndex };
  }

  function pickFromEvent(e: React.PointerEvent) {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const picked = snappedPick(x, y);
    if (!picked) return;
    if (target === 'gradient' && gradient) gradient.onChange(picked);
    else onChange(picked);
  }

  const activeValue = target === 'gradient' && gradient ? gradient.value : value;
  const cursor = useMemo(() => {
    if (activeValue.sectorIndex < 0 || activeValue.ringIndex < 0) return { x: radius, y: radius };
    const innerR = radius * innerNeutral;
    const ringW = (radius - innerR) / rings.length;
    const rMid = innerR + (activeValue.ringIndex + 0.5) * ringW;
    const angDeg = activeValue.sectorIndex * 30 + 15; // sector mid, 0 at top
    const a = ((angDeg - 90) * Math.PI) / 180;
    return { x: radius + Math.cos(a) * rMid, y: radius + Math.sin(a) * rMid };
  }, [activeValue.ringIndex, activeValue.sectorIndex, innerNeutral, radius, rings.length]);

  return (
    <div className="colour-picker-overlay" role="dialog" aria-modal="true">
      <div className="colour-picker-card">
        <div className="colour-picker-header">
          <div className="colour-picker-title">Colour picker</div>
          <button type="button" className="colour-picker-close" onClick={onClose} aria-label="关闭取色器">×</button>
        </div>

        <div
          className="colour-wheel-wrap"
          ref={wrapRef}
          onPointerDown={(e) => { setDragging(true); pickFromEvent(e); }}
          onPointerMove={(e) => { if (dragging) pickFromEvent(e); }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
        >
          <canvas ref={canvasRef} width={size} height={size} className="colour-wheel-canvas" />
          <div
            className="colour-wheel-cursor"
            style={{ left: cursor.x, top: cursor.y }}
            aria-hidden
          />
        </div>

        <div className="colour-picker-footer">
          <div className="colour-picker-preview" aria-hidden>
            <span className="colour-picker-swatch" style={{ background: activeValue.hex }} />
            <span className="colour-picker-hex">{activeValue.hex}</span>
          </div>
          <div className="colour-picker-actions">
            <button type="button" className="materials-btn materials-btn-cancel" onClick={onClose}>Done</button>
          </div>
        </div>
        {gradient && (
          <div className="colour-picker-gradient">
            <div className="colour-picker-gradient-title">Gradient</div>
            <div className="colour-picker-gradient-top">
              <button
                type="button"
                className={`colour-picker-target colour-picker-target-endpoint ${target === 'base' ? 'colour-picker-target-active' : ''}`}
                onClick={() => setTarget('base')}
              >
                <span className="colour-picker-target-swatch" style={{ background: value.hex }} />
                <span className="colour-picker-target-label">Start</span>
              </button>
              <div
                className="colour-picker-gradient-preview"
                style={{ background: `linear-gradient(90deg, ${value.hex} 0%, ${gradient.value.hex} 100%)` }}
                aria-hidden
              />
              <button
                type="button"
                className={`colour-picker-target colour-picker-target-endpoint ${target === 'gradient' ? 'colour-picker-target-active' : ''}`}
                onClick={() => setTarget('gradient')}
              >
                <span className="colour-picker-target-swatch" style={{ background: gradient.value.hex }} />
                <span className="colour-picker-target-label">End</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
