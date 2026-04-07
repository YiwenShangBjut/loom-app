import type { Point } from './physics/types';
import type { MaterialTextureId } from './rendering/materialTextures';

/** 用户保存的笔刷：一条线的完整信息，供后续绕线调取 */
export interface SavedBrush {
  id: string;
  name: string;
  /** 下垂后的路径点（与画布坐标一致） */
  points: Point[];
  textureId: MaterialTextureId;
  /** 颜色 hex，如 #7dd3d0 */
  strokeStyle: string;
  /** 可选：渐变终点色（起点为 `strokeStyle`） */
  gradientStrokeStyle?: string;
  /** 材质解析后的线宽（用于渲染） */
  lineWidth: number;
  /** 用户设置的粗细 0–100 */
  thickness: number;
  /** 用户设置的柔软度 0–100；缺失则兼容旧数据 */
  softness?: number;
  /** 用户设置的不透明度 0–100 */
  opacity: number;
  createdAt: number;
}

const STORAGE_KEY = 'loom-saved-brushes';

export function getSavedBrushes(): SavedBrush[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Newest first: My materials thumbnails should show latest additions at the front.
    return [...(parsed as SavedBrush[])].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch {
    return [];
  }
}

export function saveBrush(brush: Omit<SavedBrush, 'id' | 'createdAt'>): SavedBrush {
  const withMeta: SavedBrush = {
    ...brush,
    id: `brush-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: Date.now(),
  };
  const list = getSavedBrushes();
  list.unshift(withMeta);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return withMeta;
}

export function updateBrush(
  id: string,
  updates: Partial<Omit<SavedBrush, 'id' | 'createdAt' | 'points'>>
): SavedBrush | null {
  const list = getSavedBrushes();
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...updates };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return list[i];
}

export function deleteBrush(id: string): boolean {
  const list = getSavedBrushes();
  const i = list.findIndex((b) => b.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return true;
}
