import Matter from 'matter-js';
import type { Point } from './types';
import type { MaterialTextureId } from '../rendering/materialTextures';
import { MATERIAL_TEXTURE_PRESETS } from '../rendering/materialTextures';
import { buildPhysicsPathIndices, expandSparseSaggedToFull } from './pathPhysicsDownsample';

const { Engine, World, Bodies, Constraint } = Matter;

export interface SagOptions {
  /** Soft nodes between each pair of path points (more = smoother sag). */
  nodesPerSegment?: number;
  /** Constraint stiffness 0..1; lower = looser, more sag. */
  stiffness?: number;
  /** Gravity Y (pixels per step²). */
  gravityY?: number;
  /** Body air friction; higher = slower, more damped motion. */
  frictionAir?: number;
  /** Node mass; higher = heavier feel. */
  mass?: number;
}

const DEFAULT_OPTIONS: Required<SagOptions> = {
  nodesPerSegment: 4,
  stiffness: 0.5,
  gravityY: 0.6,
  frictionAir: 0.04,
  mass: 0.12,
};

const DEFAULT_MAX_PHYSICS_VERTICES = 56;

export interface ThreadSagManagerOptions extends SagOptions {
  /**
   * 每条线参与 Matter 模拟的最大顶点数（含端点）。展开后的长路径会降采样模拟，再插值回完整顶点供绘制。
   */
  maxPhysicsVertices?: number;
}

/**
 * One sagged rope: path points are fixed (pegs), segments between them
 * are soft chains that sag under gravity. Bodies are stored in draw order.
 */
export class SaggedRope {
  private engine: Matter.Engine;
  private bodies: Matter.Body[] = [];
  private constraints: Matter.Constraint[] = [];

  constructor(engine: Matter.Engine, path: Point[], options: SagOptions = {}) {
    this.engine = engine;
    const opts = { ...DEFAULT_OPTIONS, ...options };
    if (path.length < 2) return;

    const nodeRadius = 2;
    const pathPoints = path;
    const n = opts.nodesPerSegment;

    // One fixed body per path point (pegs)
    const pegs: Matter.Body[] = [];
    for (let i = 0; i < pathPoints.length; i++) {
      const P = pathPoints[i];
      pegs.push(
        Bodies.circle(P.x, P.y, nodeRadius, {
          isStatic: true,
          label: `peg_${i}`,
          collisionFilter: { group: -1 },
        })
      );
    }
    this.bodies.push(pegs[0]);

    for (let i = 0; i < pathPoints.length - 1; i++) {
      const A = pathPoints[i];
      const B = pathPoints[i + 1];
      const segLen = Math.hypot(B.x - A.x, B.y - A.y);
      const constraintLen = segLen / (n + 1);

      const segBodies: Matter.Body[] = [pegs[i]];
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        const x = A.x + (B.x - A.x) * t;
        // Smaller initial offset reduces "bounce-on-load" amplitude.
        const y = A.y + (B.y - A.y) * t + 1.5;
        segBodies.push(
          Bodies.circle(x, y, nodeRadius, {
            mass: opts.mass,
            frictionAir: opts.frictionAir,
            label: `soft_${i}_${k}`,
            collisionFilter: { group: -1 },
          })
        );
      }
      segBodies.push(pegs[i + 1]);

      for (let j = 1; j < segBodies.length; j++) this.bodies.push(segBodies[j]);

      for (let j = 0; j < segBodies.length - 1; j++) {
        this.constraints.push(
          Constraint.create({
            bodyA: segBodies[j],
            bodyB: segBodies[j + 1],
            length: constraintLen,
            stiffness: opts.stiffness,
            damping: 0.08,
          })
        );
      }
    }

    World.add(engine.world, this.bodies);
    World.add(engine.world, this.constraints);
  }

  getPoints(): Point[] {
    return this.bodies.map((b) => ({ x: b.position.x, y: b.position.y }));
  }

  destroy(): void {
    World.remove(this.engine.world, this.bodies);
    World.remove(this.engine.world, this.constraints);
  }
}

export interface TwoEndpointRopeOptions {
  stiffness?: number;
  gravityY?: number;
  frictionAir?: number;
  mass?: number;
}

/**
 * Rope where only the first and last path points are fixed; all points in between
 * are soft bodies connected by length-preserving constraints, so the full drawn
 * path length is preserved and the middle sags under gravity.
 */
export class TwoEndpointRope {
  private engine: Matter.Engine;
  private bodies: Matter.Body[] = [];
  private constraints: Matter.Constraint[] = [];

  constructor(
    engine: Matter.Engine,
    path: Point[],
    options: TwoEndpointRopeOptions = {}
  ) {
    this.engine = engine;
    const opts = {
      stiffness: options.stiffness ?? 0.5,
      gravityY: options.gravityY ?? 0.48,
      frictionAir: options.frictionAir ?? 0.05,
      mass: options.mass ?? 0.12,
    };
    if (path.length < 2) return;

    const nodeRadius = 2;
    const points = path;

    // First point: fixed (peg)
    const first = Bodies.circle(points[0].x, points[0].y, nodeRadius, {
      isStatic: true,
      label: 'peg_start',
      collisionFilter: { group: -1 },
    });
    this.bodies.push(first);

    // Middle points: soft bodies
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const body = Bodies.circle(p.x, p.y, nodeRadius, {
        mass: opts.mass,
        frictionAir: opts.frictionAir,
        label: `soft_${i}`,
        collisionFilter: { group: -1 },
      });
      this.bodies.push(body);
    }

    // Last point: fixed (peg)
    const last = Bodies.circle(
      points[points.length - 1].x,
      points[points.length - 1].y,
      nodeRadius,
      {
        isStatic: true,
        label: 'peg_end',
        collisionFilter: { group: -1 },
      }
    );
    this.bodies.push(last);

    // Constraints between consecutive bodies, length = original segment length
    for (let i = 0; i < this.bodies.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      this.constraints.push(
        Constraint.create({
          bodyA: this.bodies[i],
          bodyB: this.bodies[i + 1],
          length: len,
          stiffness: opts.stiffness,
          damping: 0.1,
        })
      );
    }

    World.add(engine.world, this.bodies);
    World.add(engine.world, this.constraints);
  }

  getPoints(): Point[] {
    return this.bodies.map((b) => ({ x: b.position.x, y: b.position.y }));
  }

  destroy(): void {
    World.remove(this.engine.world, this.bodies);
    World.remove(this.engine.world, this.constraints);
  }
}

/**
 * Holds one Matter engine and one SaggedRope per committed thread path.
 * Step once per frame and return sagged points for each thread.
 */
export class ThreadSagManager {
  /** Matter 建议单次 update 的 delta 不超过约一帧@60Hz；超出时只推进这么多，避免大步长炸约束链。 */
  private static readonly MAX_DELTA_MS = 1000 / 60;

  private engine: Matter.Engine;
  private ropes: SaggedRope[] = [];
  private options: Required<SagOptions>;
  private maxPhysicsVertices: number;
  /** Per-rope: sparse indices into full path + original vertex count for upsampling after sag. */
  private upsampleMeta: { indices: number[]; fullCount: number }[] = [];
  /** Per-rope identity key to support incremental setPaths updates. */
  private ropeKeys: string[] = [];

  constructor(options: ThreadSagManagerOptions = {}) {
    const { maxPhysicsVertices, ...sagOpts } = options;
    this.options = { ...DEFAULT_OPTIONS, ...sagOpts };
    this.maxPhysicsVertices = maxPhysicsVertices ?? DEFAULT_MAX_PHYSICS_VERTICES;
    this.engine = Engine.create({
      // Let settled ropes sleep so adding a new rope won't wake and re-bounce all old ropes,
      // which is especially noticeable on Android WebView physics stepping.
      enableSleeping: true,
      gravity: { x: 0, y: this.options.gravityY },
    });
  }

  /**
   * Sync ropes to match the given paths (one path per committed thread).
   * Rebuild all ropes in-order so rope index always matches committed thread index.
   * This avoids index drift after deleting a middle thread (otherwise only pop/push
   * would keep stale ropes at shifted indices).
   *
   * When textureIds are provided, each rope uses that material's stiffness.
   * If stiffnessOverrides is provided, it wins per-thread.
   */
  setPaths(
    paths: Point[][],
    textureIds?: MaterialTextureId[],
    stiffnessOverrides?: number[]
  ): void {
    const entries: {
      key: string;
      sparsePath: Point[];
      upsample: { indices: number[]; fullCount: number };
      opts: SagOptions;
    }[] = [];
    for (let i = 0; i < paths.length; i++) {
      const entry = this.buildRopeEntry(paths[i], textureIds?.[i], stiffnessOverrides?.[i]);
      if (entry) entries.push(entry);
    }

    // Incremental update: keep unchanged prefix ropes to avoid global re-bounce.
    let firstChanged = 0;
    const common = Math.min(this.ropeKeys.length, entries.length);
    while (firstChanged < common && this.ropeKeys[firstChanged] === entries[firstChanged].key) {
      firstChanged += 1;
    }

    this.destroyFrom(firstChanged);
    for (let i = firstChanged; i < entries.length; i++) {
      const e = entries[i];
      this.ropes.push(new SaggedRope(this.engine, e.sparsePath, e.opts));
      this.upsampleMeta.push(e.upsample);
      this.ropeKeys.push(e.key);
    }
  }

  step(deltaMs: number): void {
    const dt = Math.max(0, Math.min(deltaMs, ThreadSagManager.MAX_DELTA_MS));
    Engine.update(this.engine, dt);
  }

  getSaggedPoints(threadIndex: number): Point[] | null {
    const rope = this.ropes[threadIndex];
    if (!rope) return null;
    const sparse = rope.getPoints();
    const meta = this.upsampleMeta[threadIndex];
    if (!meta || meta.indices.length === meta.fullCount) {
      return sparse.map((p) => ({ x: p.x, y: p.y }));
    }
    return expandSparseSaggedToFull(meta.indices, sparse, meta.fullCount);
  }

  getRopeCount(): number {
    return this.ropes.length;
  }

  private clear(): void {
    this.destroyFrom(0);
  }

  private destroyFrom(index: number): void {
    for (let i = index; i < this.ropes.length; i++) this.ropes[i].destroy();
    this.ropes.length = index;
    this.upsampleMeta.length = index;
    this.ropeKeys.length = index;
  }

  private buildRopeEntry(
    path: Point[],
    tid?: MaterialTextureId,
    stiffnessOverride?: number
  ): {
    key: string;
    sparsePath: Point[];
    upsample: { indices: number[]; fullCount: number };
    opts: SagOptions;
  } | null {
    if (path.length < 2) return null;
    const resolvedStiffness =
      stiffnessOverride != null && Number.isFinite(stiffnessOverride)
        ? Math.max(0, Math.min(1, stiffnessOverride))
        : tid
          ? MATERIAL_TEXTURE_PRESETS[tid].stiffness
          : this.options.stiffness;

    // Matter.js 中 constraint stiffness 越大，通常越“硬”，下垂越少；
    // 所以 softness 越软（stiffness 越低）时，需要更明显的下垂。
    const saginess = Math.max(0, Math.min(1, 1 - resolvedStiffness)); // 0=hard, 1=soft
    const gravityYForSag = this.options.gravityY * (1 + saginess * 2.0); // up to 3x

    const stiffnessForConstraint = Math.max(0.02, resolvedStiffness); // avoid 0
    const opts = tid
      ? {
          ...this.options,
          // softness/sag
          stiffness: stiffnessForConstraint,
          gravityY: gravityYForSag,
          // chenille: much softer + slower/heavier + smoother segments
          ...(tid === 'chenille'
            ? { frictionAir: 0.09, mass: 0.18, nodesPerSegment: 5 }
            : {}),
          // wool: retains some structure, less damping
          ...(tid === 'wool'
            ? { frictionAir: 0.04, mass: 0.13, nodesPerSegment: 4 }
            : {}),
          // felt: lightest, least gravity, soft halo
          ...(tid === 'felt'
            ? { frictionAir: 0.025, mass: 0.05, nodesPerSegment: 6 }
            : {}),
          // thread: controlled / precise (more damping, slightly heavier)
          ...(tid === 'thread'
            ? { frictionAir: 0.05, mass: 0.14, nodesPerSegment: 4 }
            : {}),
          // steel: very stiff, minimal sag, quick settle
          ...(tid === 'steel'
            ? { frictionAir: 0.03, mass: 0.10, nodesPerSegment: 3 }
            : {}),
          // rope: thick + stiff cord, little sag, slightly heavier than thread
          ...(tid === 'rope'
            ? { frictionAir: 0.034, mass: 0.13, nodesPerSegment: 3 }
            : {}),
        }
      : {
          ...this.options,
          stiffness: stiffnessForConstraint,
          gravityY: gravityYForSag,
        };
    const fullCount = path.length;
    const indices = buildPhysicsPathIndices(fullCount, this.maxPhysicsVertices);
    const sparsePath = indices.map((j) => path[j]);
    // Use a stable, low-sensitivity identity:
    // Android WebView can introduce tiny per-frame path drift; hashing every
    // vertex makes unchanged ropes look "changed" and triggers re-bounce.
    // Endpoints + vertex count + material/stiffness are enough for incremental reuse.
    const first = path[0];
    const last = path[path.length - 1];
    const roundedFirst = `${Math.round(first.x)},${Math.round(first.y)}`;
    const roundedLast = `${Math.round(last.x)},${Math.round(last.y)}`;
    const key = [
      tid ?? 'none',
      resolvedStiffness.toFixed(4),
      fullCount.toString(),
      roundedFirst,
      roundedLast,
    ].join('::');
    return {
      key,
      sparsePath,
      upsample: { indices, fullCount },
      opts,
    };
  }

  destroy(): void {
    this.clear();
    Engine.clear(this.engine);
  }
}
