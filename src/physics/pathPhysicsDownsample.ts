import type { Point } from './types';

/**
 * Pick vertex indices into an expanded render path for Matter sag simulation.
 * Always includes first and last vertex; caps count to limit bodies/constraints.
 */
export function buildPhysicsPathIndices(vertexCount: number, maxVertices: number): number[] {
  if (vertexCount <= 0) return [];
  if (vertexCount === 1) return [0];
  if (vertexCount <= maxVertices) {
    return Array.from({ length: vertexCount }, (_, i) => i);
  }
  const m = maxVertices;
  const n = vertexCount;
  const raw: number[] = [];
  for (let j = 0; j < m; j++) {
    raw.push(Math.round((j * (n - 1)) / (m - 1)));
  }
  raw[0] = 0;
  raw[m - 1] = n - 1;
  const out: number[] = [];
  for (const x of raw) {
    if (out.length === 0 || x > out[out.length - 1]) out.push(x);
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/**
 * Map sparse sagged polyline (physics vertices) back to full render vertex count
 * by linear interpolation in original index space.
 */
export function expandSparseSaggedToFull(
  downIndices: number[],
  sparseSagged: Point[],
  fullCount: number
): Point[] {
  if (sparseSagged.length < 2 || fullCount < 2) {
    return sparseSagged.length > 0 ? sparseSagged.map((p) => ({ x: p.x, y: p.y })) : [];
  }
  const m = downIndices.length;
  if (m !== sparseSagged.length) {
    return sparseSagged.map((p) => ({ x: p.x, y: p.y }));
  }
  if (m === fullCount) {
    let identity = true;
    for (let k = 0; k < m; k++) {
      if (downIndices[k] !== k) {
        identity = false;
        break;
      }
    }
    if (identity) return sparseSagged.map((p) => ({ x: p.x, y: p.y }));
  }

  const out: Point[] = [];
  for (let i = 0; i < fullCount; i++) {
    let di = 0;
    while (di + 1 < m && downIndices[di + 1] < i) di++;
    const ia = downIndices[di];
    const ib = downIndices[Math.min(di + 1, m - 1)];
    const pa = sparseSagged[di];
    const pb = sparseSagged[Math.min(di + 1, m - 1)];
    if (ib <= ia) {
      out.push({ x: pa.x, y: pa.y });
      continue;
    }
    const t = (i - ia) / (ib - ia);
    out.push({
      x: pa.x + t * (pb.x - pa.x),
      y: pa.y + t * (pb.y - pa.y),
    });
  }
  return out;
}
