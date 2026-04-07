import Matter from 'matter-js';
import type { MaterialPreset, Point } from './types';

const { Engine, World, Bodies, Constraint } = Matter;

/**
 * RopePhysics manages a Matter.js engine containing:
 *  - A chain of circular bodies (rope nodes) connected by constraints
 *  - Two pinned anchor bodies at the ends of the loom guide bar
 *
 * It knows nothing about pixels or PixiJS — all coordinates are in the
 * same pixel-space as the canvas so the renderer can read them directly.
 */
export class RopePhysics {
  private engine: Matter.Engine;
  private nodes: Matter.Body[] = [];
  private dragConstraint: Matter.Constraint | null = null;
  private preset: MaterialPreset;

  constructor(preset: MaterialPreset) {
    this.preset = preset;
    this.engine = Engine.create({
      gravity: { x: 0, y: 1.2 },
    });
  }

  /**
   * Build the rope chain between two anchor points.
   * Call once after the canvas dimensions are known.
   *
   * @param ax  Left anchor X (canvas pixels)
   * @param ay  Left anchor Y
   * @param bx  Right anchor X
   * @param by  Right anchor Y
   */
  build(ax: number, ay: number, bx: number, by: number): void {
    this.clear();

    const { nodeCount, mass, stiffness } = this.preset;
    const nodeRadius = 4;

    // Fixed anchor bodies (isStatic keeps them in place)
    const anchorLeft = Bodies.circle(ax, ay, nodeRadius, { isStatic: true, label: 'anchorLeft' });
    const anchorRight = Bodies.circle(bx, by, nodeRadius, { isStatic: true, label: 'anchorRight' });
    World.add(this.engine.world, [anchorLeft, anchorRight]);

    // Rope nodes — spaced linearly between anchors, slightly below
    const bodies: Matter.Body[] = [anchorLeft];
    for (let i = 1; i <= nodeCount; i++) {
      const t = i / (nodeCount + 1);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t + 2; // tiny downward offset to seed the sag
      const node = Bodies.circle(x, y, nodeRadius, {
        mass,
        frictionAir: this.preset.damping,
        label: `node_${i}`,
        collisionFilter: { mask: 0 }, // nodes don't collide with each other
      });
      bodies.push(node);
    }
    bodies.push(anchorRight);
    World.add(this.engine.world, bodies.slice(1, -1)); // add only the non-static nodes

    // Constraints linking adjacent bodies
    const segmentLength = Math.hypot(bx - ax, by - ay) / (nodeCount + 1);
    const constraints: Matter.Constraint[] = [];
    for (let i = 0; i < bodies.length - 1; i++) {
      constraints.push(
        Constraint.create({
          bodyA: bodies[i],
          bodyB: bodies[i + 1],
          length: segmentLength,
          stiffness,
          damping: 0.01,
        })
      );
    }
    World.add(this.engine.world, constraints);

    // Store references — exclude the two static anchors from the renderable list
    this.nodes = bodies;
  }

  /** Advance the simulation by one frame (call on every animation tick) */
  step(deltaMs: number): void {
    Engine.update(this.engine, deltaMs);
  }

  /** Current positions of all nodes (including anchors at index 0 and last) */
  getNodeStates(): Point[] {
    return this.nodes.map(b => ({ x: b.position.x, y: b.position.y }));
  }

  /**
   * Attach a mouse/touch constraint to whichever node is closest to (px, py).
   * The caller holds the returned constraint reference to update its position.
   */
  startDrag(px: number, py: number): void {
    // Find the nearest non-static node
    const movable = this.nodes.filter(b => !b.isStatic);
    if (movable.length === 0) return;

    let nearest = movable[0];
    let minDist = Infinity;
    for (const b of movable) {
      const d = Math.hypot(b.position.x - px, b.position.y - py);
      if (d < minDist) { minDist = d; nearest = b; }
    }

    // Only grab if the pointer is reasonably close
    if (minDist > 60) return;

    this.dragConstraint = Constraint.create({
      pointA: { x: px, y: py },
      bodyB: nearest,
      stiffness: 0.6,
      damping: 0.1,
      length: 0,
    });
    World.add(this.engine.world, this.dragConstraint);
  }

  /** Update the drag point while the pointer moves */
  moveDrag(px: number, py: number): void {
    if (!this.dragConstraint) return;
    this.dragConstraint.pointA = { x: px, y: py };
  }

  /** Release the drag constraint */
  endDrag(): void {
    if (!this.dragConstraint) return;
    World.remove(this.engine.world, this.dragConstraint);
    this.dragConstraint = null;
  }

  /** Change material preset and rebuild from the same anchor positions */
  applyPreset(preset: MaterialPreset): void {
    if (this.nodes.length < 2) return;
    const first = this.nodes[0];
    const last = this.nodes[this.nodes.length - 1];
    this.preset = preset;
    this.build(first.position.x, first.position.y, last.position.x, last.position.y);
  }

  private clear(): void {
    World.clear(this.engine.world, false);
    this.nodes = [];
    this.dragConstraint = null;
  }

  destroy(): void {
    this.clear();
    Engine.clear(this.engine);
  }
}
