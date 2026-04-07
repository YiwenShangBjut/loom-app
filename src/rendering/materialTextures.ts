/**
 * Material texture IDs used by the materials panel and rope rendering.
 * Each has a default thickness and sag stiffness (softest = felt, stiffest = steel).
 */
export type MaterialTextureId =
  | 'none'
  | 'wool'
  | 'thread'
  | 'chenille'
  | 'felt'
  | 'steel'
  | 'rope';

export const MATERIAL_TEXTURE_IDS: MaterialTextureId[] = [
  'none',
  'wool',
  'thread',
  'chenille',
  'felt',
  'steel',
  'rope',
];

export interface InnerShadowConfig {
  /** Master strength 0..1. Set 0 to disable. */
  strength: number;
  /** Alpha multiplier for very edge darkening. */
  edgeAlpha: number;
  /** Alpha multiplier for near-edge darkening. */
  edgeInnerAlpha: number;
  /** Alpha multiplier for center highlight. */
  highlightAlpha: number;
  /** Gradient stops for shadow band and center highlight. */
  edgeOuterStop: number;
  edgeInnerStop: number;
  highlightOuterStop: number;
}

export interface MaterialTexturePreset {
  label: string;
  /** Default line width in px. Larger value = thicker look. */
  lineWidth: number;
  /** Sag stiffness 0..1. Higher values correspond to higher stiffness in physics. */
  stiffness: number;
  /** Gravity multiplier for sag (slightly different feel per material). */
  gravityY: number;
  /** Default tint (hex). Light gray = initial. */
  color: number;
  /** End cap roundness 0..1. Wool = 1 (most rounded), steel = 0 (sharp). */
  endRoundness: number;
  /** Inner shadow params for 3D effect. */
  innerShadow: InnerShadowConfig;
}

/** Light gray used as initial/default tint for all materials. */
export const DEFAULT_TINT = 0xd8d4cc;

export const MATERIAL_TEXTURE_PRESETS: Record<MaterialTextureId, MaterialTexturePreset> = {
  none: {
    label:              'None',
    lineWidth:          5,
    stiffness:          0.6,
    gravityY:           0.5,
    color:              DEFAULT_TINT,
    endRoundness:       0.5,
    innerShadow: {
      strength: 0.12,
      edgeAlpha: 0.34,
      edgeInnerAlpha: 0.12,
      highlightAlpha: 0.16,
      edgeOuterStop: 0,
      edgeInnerStop: 0.2,
      highlightOuterStop: 0.32,
    },
  },
  wool: {
    label:              'Wool Yarn',
    lineWidth:          8,
    stiffness:          0.45,
    gravityY:           0.3,
    color:              DEFAULT_TINT,
    endRoundness:       1,
    innerShadow: {
      strength: 0.3,
      edgeAlpha: 0.34,
      edgeInnerAlpha: 0.12,
      highlightAlpha: 0.16,
      edgeOuterStop: 0,
      edgeInnerStop: 0.2,
      highlightOuterStop: 0.32,
    },
  },
  thread: {
    label:              'Thread',
    lineWidth:          2.5,
    stiffness:          0.6,
    gravityY:           0.48,
    color:              DEFAULT_TINT,
    endRoundness:       0.45,
    innerShadow: {
      strength: 0.3,
      edgeAlpha: 0.34,
      edgeInnerAlpha: 0.12,
      highlightAlpha: 0.3,
      edgeOuterStop: 0,
      edgeInnerStop: 0.2,
      highlightOuterStop: 0.32,
    },
  },
  chenille: {
    label:              'Chenille Yarn',
    lineWidth:          5,
    stiffness:          0.18,
    gravityY:           0.65,
    color:              DEFAULT_TINT,
    endRoundness:       0.8,
    innerShadow: {
      strength: 0.08,
      edgeAlpha: 0.42,
      edgeInnerAlpha: 0.18,
      highlightAlpha: 0.8,
      edgeOuterStop: 0,
      edgeInnerStop: 0.18,
      highlightOuterStop: 0.28,
    },
  },
  felt: {
    label:              'Felt Wool',
    lineWidth:          14,
    stiffness:          0.25,
    gravityY:           0.05,
    color:              DEFAULT_TINT,
    endRoundness:       1,
    innerShadow: {
      strength: 0,
      edgeAlpha: 0.34,
      edgeInnerAlpha: 0.12,
      highlightAlpha: 0.16,
      edgeOuterStop: 0,
      edgeInnerStop: 0.2,
      highlightOuterStop: 0.32,
    },
  },
  steel: {
    label:              'Steel Wire',
    lineWidth:          3.5,
    stiffness:          1,
    gravityY:           0,
    color:              DEFAULT_TINT,
    endRoundness:       0,
    innerShadow: {
      strength: 0.44,
      edgeAlpha: 0.5,
      edgeInnerAlpha: 0.2,
      highlightAlpha: 0.32,
      edgeOuterStop: 0,
      edgeInnerStop: 0.18,
      highlightOuterStop: 0.26,
    },
  },
  /** 粗扭绳：默认最粗一档、较硬；画布条带为程序化生成（示意图仅用于 UI 色板）。 */
  rope: {
    label:              'Rope',
    lineWidth:          15,
    stiffness:          0.88,
    gravityY:           0.18,
    color:              DEFAULT_TINT,
    endRoundness:       0.32,
    innerShadow: {
      strength: 0.38,
      edgeAlpha: 0.46,
      edgeInnerAlpha: 0.18,
      highlightAlpha: 0.26,
      edgeOuterStop: 0,
      edgeInnerStop: 0.18,
      highlightOuterStop: 0.26,
    },
  },
};
