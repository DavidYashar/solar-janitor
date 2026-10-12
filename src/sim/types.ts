export type PlayMode = 'surface' | 'space' | 'docked'
export type Phase = 'ready' | 'playing' | 'paused' | 'finished'
export type Outcome = 'none' | 'won' | 'lost'
export type TransitionKind = 'takeoff' | 'landing'
export type JunkClass = 'scrap' | 'tech' | 'hazardous'
export type JunkStatus = 'ground' | 'carried' | 'hold' | 'delivered'
export type EventKind =
  | 'pickup' | 'deposit' | 'deliver' | 'buy' | 'dock' | 'undock'
  | 'takeoff' | 'land' | 'oxygen' | 'refill' | 'rescue' | 'block'
  | 'clean' | 'win' | 'lose' | 'scrape'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Junk {
  id: number
  planet: number
  cls: JunkClass
  lat: number
  lon: number
  status: JunkStatus
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
  hopCooldown: number
}

export interface Ship {
  x: number
  y: number
  z: number
  vx: number
  vz: number
  yaw: number
  speed: number
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
  /** -1..1 strafe (surface: east) */
  x: number
  /** -1..1 forward (surface: north) */
  y: number
  /** Shift (surface: sprint, space: boost) */
  boost: boolean
  /** Space (surface: hop, space: boost) */
  hop: boolean
}

export interface Game {
  seed: number
  rngState: number
  phase: Phase
  outcome: Outcome
  mode: PlayMode
  transition: Transition | null
  time: number
  score: number
  credits: number
  health: number
  oxygen: number
  lowOxygenWarned: boolean
  oxygenEmptyWarned: boolean
  atLander: boolean
  scrapeTimer: number
  planetId: number
  player: Player
  ship: Ship
  earthAngle: number
  issAngle: number
  moonAngle: number
  earthPos: Vec3
  issPos: Vec3
  dockPos: Vec3
  moonPos: Vec3
  junk: Junk[]
  upgrades: string[]
  delivered: number
  bestBatch: number
  trips: number
  rescued: boolean
  events: GameEvent[]
  nextId: number
}
