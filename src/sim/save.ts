import { SAVE_VERSION } from './config.ts'
import { RELIC_BY_TOOL, SHOP_BY_ID } from './economy.ts'
import { PLANETS } from './planets.ts'
import {
  computeBodies, createGame, placePlayerAtLander, placeShipOnPad, resetHazards,
} from './game.ts'
import type { Game, JunkStatus, PlayMode } from './types.ts'

/**
 * Pure save format for "Continue" (plan §4). Nothing here touches localStorage —
 * `main.ts` owns storage, this module owns shape, validation and round-tripping.
 */

const STATUS_TO_CODE: Record<JunkStatus, number> = { ground: 0, carried: 1, hold: 2, delivered: 3 }
const CODE_TO_STATUS: JunkStatus[] = ['ground', 'carried', 'hold', 'delivered']

export interface SaveData {
  v: number
  seed: number
  savedAt: number
  time: number
  score: number
  credits: number
  health: number
  oxygen: number
  planetId: number
  mode: PlayMode
  /** earth, iss, moon, mars */
  angles: number[]
  /** status code per junk item, in `game.junk` order */
  junk: number[]
  upgrades: string[]
  relicTools: string[]
  delivered: number
  bestBatch: number
  trips: number
  rescued: boolean
  planetsCleaned: number
  /** lat, lon, h, facing */
  player: number[]
  /** x, y, z, vx, vy, vz, qx, qy, qz, qw */
  ship: number[]
}

export function serializeSave(game: Game, savedAt = Date.now()): SaveData {
  return {
    v: SAVE_VERSION,
    seed: game.seed,
    savedAt,
    time: game.time,
    score: game.score,
    credits: game.credits,
    health: game.health,
    oxygen: game.oxygen,
    planetId: game.planetId,
    mode: game.mode,
    angles: [game.earthAngle, game.issAngle, game.moonAngle, game.marsAngle],
    junk: game.junk.map(item => STATUS_TO_CODE[item.status] ?? 0),
    upgrades: [...game.upgrades],
    relicTools: [...game.relicTools],
    delivered: game.delivered,
    bestBatch: game.bestBatch,
    trips: game.trips,
    rescued: game.rescued,
    planetsCleaned: game.planetsCleaned,
    player: [game.player.lat, game.player.lon, game.player.h, game.player.facing],
    ship: [
      game.ship.x, game.ship.y, game.ship.z,
      game.ship.vx, game.ship.vy, game.ship.vz,
      game.ship.q.x, game.ship.q.y, game.ship.q.z, game.ship.q.w,
    ],
  }
}

export function encodeSave(data: SaveData): string {
  return JSON.stringify(data)
}

/** Parses and structurally validates a stored save string. */
export function decodeSave(text: string | null | undefined): SaveData | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Partial<SaveData>
  if (!Number.isInteger(data.v) || (data.v as number) < 1 || (data.v as number) > SAVE_VERSION) return null
  if (!Number.isInteger(data.seed)) return null
  if (data.mode !== 'surface' && data.mode !== 'space' && data.mode !== 'docked') return null
  if (!Array.isArray(data.junk) || !Array.isArray(data.ship) || !Array.isArray(data.player)) return null
  if (!Array.isArray(data.angles) || !Array.isArray(data.upgrades) || !Array.isArray(data.relicTools)) return null
  return data as SaveData
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Rebuilds a live Game from save data. Returns null when the save cannot be
 * trusted (wrong junk layout, unusable ship data) so the caller can fall back
 * to a fresh run (plan §4: "handle corrupt/missing data gracefully").
 */
export function restoreSave(data: SaveData): Game | null {
  const game = createGame({ seed: data.seed })

  if (data.junk.length !== game.junk.length) return null
  for (let i = 0; i < game.junk.length; i++) {
    const code = data.junk[i]
    if (!Number.isInteger(code) || code < 0 || code > 3) continue
    game.junk[i].status = CODE_TO_STATUS[code]
  }

  const shipX = num(data.ship[0], NaN)
  const shipY = num(data.ship[1], NaN)
  const shipZ = num(data.ship[2], NaN)
  if (!Number.isFinite(shipX) || !Number.isFinite(shipY) || !Number.isFinite(shipZ)) return null

  game.seed = data.seed
  game.rngState = game.seed
  game.time = Math.max(0, num(data.time, 0))
  game.score = Math.max(0, num(data.score, 0))
  game.credits = Math.max(0, num(data.credits, 0))
  game.health = Math.max(1, Math.min(100, num(data.health, 100)))
  game.oxygen = Math.max(0, num(data.oxygen, 100))
  game.planetId = Number.isInteger(data.planetId) ? Math.max(0, Math.min(PLANETS.length - 1, data.planetId)) : 0
  game.delivered = Math.max(0, num(data.delivered, 0))
  game.bestBatch = Math.max(0, num(data.bestBatch, 0))
  game.trips = Math.max(0, num(data.trips, 0))
  game.rescued = bool(data.rescued, false)
  game.planetsCleaned = Math.max(0, num(data.planetsCleaned, 0))
  game.upgrades = data.upgrades.filter(id => typeof id === 'string' && id in SHOP_BY_ID)
  game.relicTools = data.relicTools.filter(tool => typeof tool === 'string' && tool in RELIC_BY_TOOL)

  game.earthAngle = num(data.angles[0], game.earthAngle)
  game.issAngle = num(data.angles[1], game.issAngle)
  game.moonAngle = num(data.angles[2], game.moonAngle)
  game.marsAngle = num(data.angles[3], game.marsAngle)
  computeBodies(game)

  placePlayerAtLander(game)
  game.player.lat = num(data.player[0], game.player.lat)
  game.player.lon = num(data.player[1], game.player.lon)
  game.player.h = Math.max(0, num(data.player[2], 0))
  game.player.facing = num(data.player[3], 0)

  placeShipOnPad(game)
  game.ship.x = shipX
  game.ship.y = shipY
  game.ship.z = shipZ
  game.ship.vx = num(data.ship[3], 0)
  game.ship.vy = num(data.ship[4], 0)
  game.ship.vz = num(data.ship[5], 0)
  const q = {
    x: num(data.ship[6], 0),
    y: num(data.ship[7], 0),
    z: num(data.ship[8], 0),
    w: num(data.ship[9], 1),
  }
  const qLength = Math.hypot(q.x, q.y, q.z, q.w)
  if (qLength > 1e-6) {
    game.ship.q = { x: q.x / qLength, y: q.y / qLength, z: q.z / qLength, w: q.w / qLength }
  }
  game.ship.speed = Math.hypot(game.ship.vx, game.ship.vy, game.ship.vz)

  game.mode = data.mode
  game.transition = null
  game.phase = 'playing'
  game.outcome = 'none'
  resetHazards(game)
  if (game.mode === 'docked') {
    game.ship.x = game.dockPos.x
    game.ship.y = game.dockPos.y
    game.ship.z = game.dockPos.z
    game.ship.vx = 0
    game.ship.vy = 0
    game.ship.vz = 0
    game.ship.speed = 0
  }
  if (game.mode === 'surface') {
    // the janitor must be standing on the saved planet, not the default one
    placePlayerAtLander(game)
    game.player.lat = num(data.player[0], game.player.lat)
    game.player.lon = num(data.player[1], game.player.lon)
    game.player.h = Math.max(0, num(data.player[2], 0))
    game.player.facing = num(data.player[3], 0)
  }
  game.atLander = false
  game.events.length = 0
  return game
}
