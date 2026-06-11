/**
 * "Stellar Genesis" — every tunable for the cinematic intro lives here.
 * The intro plays in the SAME canvas as the hero scene: the proto-sun sits
 * exactly where the brand star (ResonanceCore) lives, so the genesis
 * condenses in place and the film becomes the page.
 */

export type IntroPlayMode = "always" | "session" | "off";
export const PLAY_MODE: IntroPlayMode = "always";
export const SESSION_KEY = "resonate-intro-played";
/** Remembers whether the listener opted into the procedural score. */
export const SOUND_PREF_KEY = "resonate-intro-sound";

export type IntroTier = "high" | "med" | "low";

/** Palette — warm only. No blues or purples anywhere in the intro. */
export const PALETTE = {
  void: "#050403",
  studioVoid: "#070708",
  champagne: "#e8a05c",
  /** The hero star's exact gold — genesis recolors to this. */
  brandCopper: "#e09a52",
  hotCore: "#fff3d6",
  white: "#ffffff",
  ember: "#ff7a2f",
  deepAmber: "#8c4a16",
  cream: "#f5efe6",
} as const;

/** Beat boundaries (seconds). Labels in timeline.ts use these exact names. */
export const BEATS = {
  void: 0.0,
  system: 0.8,
  omen: 2.6,
  impact: 3.4,
  genesis: 3.95,
  handoff: 5.6,
  end: 6.5,
} as const;

export type BeatLabel = Exclude<keyof typeof BEATS, "end">;

/** World anchor: the proto-sun and the brand star share this position. */
export const SUN_POSITION = [0, 2.3, 0] as const;
export const SUN_RADIUS = 1.2;

/** Hero rig values the [handoff] must land on exactly (see camera-rig.tsx). */
export const HERO_CAMERA = {
  position: [-2.4, 2.7, 9] as const,
  target: [-1.1, 1.6, 0] as const,
  fov: 35,
};

export const INTRO_FOV = { system: 32, omen: 26 } as const;

/** Per-tier particle/instance counts. */
export const COUNTS = {
  high: { starfield: 8000, trail: 1500, debris: 25000, belt: 600 },
  med: { starfield: 4000, trail: 750, debris: 12500, belt: 300 },
} as const;

export const POST = {
  bloomRest: 0.9,
  bloomImpact: 3.5,
  bloomSettle: 1.6,
  aberrationSpike: 0.012,
  aberrationSettle: 0.002,
  grain: 0.035,
  vignette: { offset: 0.18, darkness: 0.6 },
} as const;

export const SHAKE = { amplitude: 0.35, decay: 0.8, dutchDeg: 4 } as const;

export const TIMESCALE = { omen: 0.45, hold: 0.2 } as const;

/** Skip affordance appears after this many seconds. */
export const SKIP_AFTER = 0.8;
/** Smooth fast-forward duration when skipping (never a hard snap). */
export const SKIP_TWEEN = 1.1;

/** Planets: warm-palette procedural worlds on inclined elliptical orbits. */
export type PlanetSpec = {
  kind: "gas" | "cratered" | "molten" | "dusty" | "veined";
  radius: number;
  orbitRadius: number;
  eccentricity: number;
  inclinationDeg: number;
  /** Radians/sec at world timeScale 1 — inner fast, outer slow. */
  angularSpeed: number;
  phase: number;
  hasRing: boolean;
};

export const PLANETS: readonly PlanetSpec[] = [
  { kind: "molten", radius: 0.14, orbitRadius: 2.6, eccentricity: 0.06, inclinationDeg: 5, angularSpeed: 0.55, phase: 0.4, hasRing: false },
  { kind: "cratered", radius: 0.12, orbitRadius: 3.5, eccentricity: 0.1, inclinationDeg: 8, angularSpeed: 0.38, phase: 2.1, hasRing: false },
  { kind: "gas", radius: 0.38, orbitRadius: 4.8, eccentricity: 0.04, inclinationDeg: 3, angularSpeed: 0.24, phase: 4.4, hasRing: true },
  { kind: "dusty", radius: 0.2, orbitRadius: 6.1, eccentricity: 0.08, inclinationDeg: 9, angularSpeed: 0.16, phase: 1.2, hasRing: false },
  { kind: "veined", radius: 0.26, orbitRadius: 7.5, eccentricity: 0.05, inclinationDeg: 6, angularSpeed: 0.11, phase: 5.3, hasRing: true },
] as const;

export const BELT = { innerRadius: 5.3, tube: 0.5, yJitter: 0.22 } as const;

/** Meteor flight: world-space cubic bezier, top-left and high to the sun. */
export const METEOR_PATH = {
  p0: [-26, 16, -14] as const,
  p1: [-14, 11, -6] as const,
  p2: [-5, 6, -2] as const,
  p3: SUN_POSITION,
} as const;
