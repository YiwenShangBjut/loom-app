/** A 2-D point in canvas logical-pixel space. */
export interface Point {
  x: number;
  y: number;
}

/**
 * An anchor point on the loom.
 *
 * `type` distinguishes the structural element the anchor lives on:
 *   'center' — the single centre peg
 *   'spoke'  — along a radial spoke; `spokeAngle` gives the spoke's axis
 *              direction in radians (angle of the vector from centre outward)
 *   'rim'    — on the circular hoop between two spokes
 *
 * `spokeAngle` is only defined for 'spoke' anchors and is used by
 * RopeRenderer to draw the over-under crossing overlay.
 */
export interface AnchorPoint extends Point {
  id:          number;
  type:        'center' | 'spoke' | 'rim';
  spokeAngle?: number; // radians; defined iff type === 'spoke'
  /** Triangle loom: unit normal pointing outside the hoop along the rim edge (for stitch bridges). */
  rimOutwardNx?: number;
  rimOutwardNy?: number;
}

/** Create page: circular hoop vs equilateral triangle (altitudes from corners). */
export type LoomShape = 'circle' | 'triangle';

export type LoomOutline =
  | { kind: 'circle'; rimRadius: number }
  | { kind: 'triangle'; v0: Point; v1: Point; v2: Point };

/**
 * Describes one "under" crossing to be drawn as an overlay.
 * The overlay erases the thread at that point and redraws the spoke on top,
 * giving the appearance that the thread passes behind the spoke.
 */
export interface UnderCrossing {
  x:          number;
  y:          number;
  spokeAngle: number; // axis along which the overlay stroke is drawn
}

/**
 * A short straight segment drawn in the topmost layer to represent the
 * portion of thread that physically rests on top of a peg when wrapping.
 * It spans from the approach tangent point (x1,y1) to the departure tangent
 * point (x2,y2) — the chord across the arc that bows around the peg.
 */
export interface BridgeSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * A thread ready for rendering.
 *
 * `points`         — Catmull-Rom spline control points (expanded with arcs).
 * `isActive`       — true while the drag gesture is still in progress.
 * `underCrossings` — spoke anchors where the thread passes behind; an overlay
 *                    covers the thread to simulate depth.
 * `bridges`        — short top-layer segments for "over" crossings; drawn
 *                    above the spoke so the thread appears to rest on the peg.
 * `textureId`      — material texture (None, Wool, Thread, etc.) when committed.
 * `lineWidth`      — stroke width in px (from material preset or override).
 * `color`          — tint hex (from material preset or colour picker).
 * `gradientColor`  — optional end tint for along-path gradient (start = `color`).
 * `opacity`        — 0..1 alpha multiplier; committed threads use value at commit time, active uses current material opacity.
 * `stiffness`      — 0..1 sag stiffness; lower = softer. Per-thread when committed (ignored when {@link skipSag}).
 * `skipSag`        — when true, physics sag is skipped; points are drawn as the user drew them (e.g. freehand doodles).
 * `ropeCaps`       — which path ends use loom wrap-style rounded caps; open-tail threads use `wrapEnd: false`.
 */
export interface RenderThread {
  points:         Point[];
  isActive:       boolean;
  underCrossings: UnderCrossing[];
  bridges:        BridgeSegment[];
  textureId?:     string;
  lineWidth?:     number;
  color?:         number;
  gradientColor?: number;
  opacity?:       number;
  stiffness?:     number;
  /** When true, {@link ThreadSagManager} does not run on this thread; only texture/color/width/opacity apply. */
  skipSag?:       boolean;
  /** Omit or leave both true for normal weave; open end in blank uses `wrapEnd: false`. */
  ropeCaps?:      { wrapStart?: boolean; wrapEnd?: boolean };
}

/**
 * Material preset — controls visual appearance.
 * Physics fields are retained for future use.
 */
export interface MaterialPreset {
  label:     string;
  nodeCount: number;
  mass:      number;
  stiffness: number;
  damping:   number;
  lineWidth: number;
  color:     number;
}

export const MATERIAL_PRESETS: Record<string, MaterialPreset> = {
  cotton: {
    label:     'Cotton',
    nodeCount: 18,
    mass:      1,
    stiffness: 0.08,
    damping:   0.08,
    lineWidth: 3,
    color:     0xe8d5b7,
  },
  felt: {
    label:     'Felt Wool',
    nodeCount: 24,
    mass:      0.2,
    stiffness: 0.04,
    damping:   0.03,
    lineWidth: 14,
    color:     0xe8e4dc,
  },
  wool: {
    label:     'Wool',
    nodeCount: 14,
    mass:      2,
    stiffness: 0.14,
    damping:   0.12,
    lineWidth: 5,
    color:     0xc8a87a,
  },
};
