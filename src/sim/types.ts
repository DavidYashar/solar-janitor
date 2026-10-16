export type PlayMode = 'surface' | 'space' | 'docked'
export type Phase = 'ready' | 'playing' | 'paused' | 'finished'
export type Outcome = 'none' | 'won' | 'lost'
export type TransitionKind = 'takeoff' | 'landing'
export type JunkClass = 'scrap' | 'tech' | 'hazardous' | 'relic'
export type JunkStatus = 'ground' | 'carried' | 'hold' | 'delivered'
export type Rank = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM' | 'LEGEND'
/**
 * Which music bed the moment calls for (plan §8). The sim decides, because the
 * decision is game state - where you are, what is coming for you - and the audio
 * layer only has to play it. `null` means nothing should be playing.
 */
export type MusicId = 'space' | 'sun' | 'earth' | 'river' | 'moon' | 'mars' | 'storm'
export type EventKind =
  | 'pickup' | 'deposit' | 'deliver' | 'buy' | 'dock' | 'undock'
  | 'takeoff' | 'land' | 'oxygen' | 'refill' | 'rescue' | 'block'
  | 'clean' | 'win' | 'lose' | 'scrape'
  | 'relic' | 'meteor' | 'storm' | 'hint' | 'heat'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Plain quaternion — sim never imports three.js, so the maths lives here. */
export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export interface Junk {
  id: number
  planet: number
  cls: JunkClass
  lat: number
  lon: number
  status: JunkStatus
  /**
   * What this piece is worth as a multiple of its class value, fixed when it is
   * picked up. See `sweepMultiplier` in game.ts and plan §5.8.
   */
  mult: number
  spin: number
  yaw: number
}

export interface Player {
  lat: number
  lon: number
  h: number
  vH: number
  vN: number
  vE: number
  facing: number
  /** -1..1: how far the chase camera is tipped up over his shoulder */
  lookPitch: number
  hopCooldown: number
}

export interface Ship {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** full-freedom orientation: thrust follows the facing vector */
  q: Quat
  speed: number
  /** last commanded thrust, -1..1 (visual + audio juice) */
  thrust: number
  boosting: boolean
  /**
   * 0..1: how cooked the hull is. Only the Sun puts heat into it and only the sky
   * takes it back out, so it is a distance readout as much as a damage one.
   */
  heat: number
}

export interface HazardState {
  /** seconds until the next meteor volley (Moon) */
  meteorTimer: number
  /** -1 idle, otherwise seconds the incoming meteor has been telegraphed */
  meteorTelegraph: number
  /** how long the current telegraph lasts (Storm Sense lengthens it) */
  meteorDelay: number
  meteorLat: number
  meteorLon: number
  /** seconds until the next dust storm (Mars) */
  stormTimer: number
  stormActive: boolean
  /** seconds the current storm has been running */
  stormTime: number
  /** has the inbound-storm warning fired for this cycle */
  stormWarned: boolean
  /** 0..1 haze strength for the renderer */
  stormIntensity: number
  /**
   * The direction the storm wind blows, as a bearing in the janitor's own frame:
   * 0 blows due north, +pi/2 due east. Re-rolled at the start of every storm, and the
   * one number the dust and the shove on the janitor are both read from, so what you
   * see streaming past is what is pushing you.
   */
  stormWindAngle: number
}

export interface Transition {
  kind: TransitionKind
  t: number
  duration: number
}

export interface GameEvent {
  kind: EventKind
  text: string
  amount: number
  /** 'surface' events carry lat/lon/h, 'space' and 'docked' events carry x/y/z */
  place: PlayMode
  lat: number
  lon: number
  h: number
  x: number
  y: number
  z: number
}

export interface Input {
  /** -1..1 sideways movement (surface: screen left/right, space: lateral strafe) */
  x: number
  /** -1..1 forward movement (surface: screen front/back, space: thrust) */
  y: number
  /**
   * Ground steering, -1..1 (surface only): full lock turns at SURFACE_TURN_RATE
   * per second. The camera sits behind the janitor, so the pointer steers him
   * instead of aiming at a screen point.
   */
  turn?: number
  /** -1..1 pitch input (space only) */
  pitch: number
  /** -1..1 yaw input (space only) */
  yaw: number
  /** -1..1 roll input (space only) */
  roll: number
  /** Shift (surface: sprint, space: boost) */
  boost: boolean
  /** Space (surface: hop, space: boost) */
  hop: boolean
}

export interface Stats {
  planetsCleaned: number
  junkDelivered: number
  bestBatch: number
  trips: number
}

export interface Game {
  seed: number
  rngState: number
  phase: Phase
  outcome: Outcome
  mode: PlayMode
  transition: Transition | null
  /**
   * True while the landing assist is flying. Set by pressing F inside a world's landing
   * zone while still moving too fast for it: the ship is then held on that world's own
   * track, bleeding the speed it has *relative to that world*, and it lands itself the
   * moment it is slow enough. Cleared by landing, by docking, and by leaving the zone.
   */
  landingAssist: boolean
  time: number
  score: number
  credits: number
  health: number
  oxygen: number
  lowOxygenWarned: boolean
  oxygenEmptyWarned: boolean
  /** the two solar-heat warnings have fired for this approach to the Sun */
  heatWarned: boolean
  heatCriticalWarned: boolean
  atLander: boolean
  scrapeTimer: number
  /** the planet whose surface the janitor is standing on (and the land target in space) */
  planetId: number
  player: Player
  ship: Ship
  hazards: HazardState
  earthAngle: number
  issAngle: number
  moonAngle: number
  marsAngle: number
  /** planet positions in the space map, indexed by planet id */
  planetPos: Vec3[]
  issPos: Vec3
  dockPos: Vec3
  moonPos: Vec3
  junk: Junk[]
  upgrades: string[]
  /** tools unlocked by delivering relics (not purchasable) */
  relicTools: string[]
  delivered: number
  bestBatch: number
  trips: number
  /** pieces picked up since the last deposit, takeoff or delivery - the sweep chain */
  sweep: number
  rescued: boolean
  planetsCleaned: number
  events: GameEvent[]
  nextId: number
}
