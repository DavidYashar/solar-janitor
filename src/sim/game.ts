import {
  AIR_CONTROL_K, BATCH_BONUS, BATCH_BONUS_SIZE, BODY_CLEARANCE, CARGO_GLOVES_BONUS,
  CARGO_RACKS_BONUS, CARRY_SLOTS, CLEAN_BONUS, DOCK_ASSIST_RADIUS, DOCK_ASSIST_RANGE,
  DOCK_ASSIST_TURN, DOCK_RADIUS, FULL_HOLD_BONUS, GRAVITY_BASE, GRAV_HOP_BONUS, GRAV_LAND_BONUS,
  HARD_LAND_DAMAGE, HARD_LAND_SPEED, HAZARD_WEAVE_REDUCTION, HEALTH_MAX, HOLD_SLOTS, HOP_COOLDOWN,
  HOP_SPEED, ISS_DOCK_OFFSET, ISS_ORBIT, ISS_ORBIT_RATE, JUNK_POINTS, LANDER_RING_RADIUS,
  LAND_MAX_SPEED, LAND_ZONE_HEIGHT, MAGBOOTS_BONUS, METEOR_DAMAGE, METEOR_INTERVAL_MAX,
  METEOR_INTERVAL_MIN, METEOR_RANGE, METEOR_RADIUS, METEOR_TELEGRAPH, METEOR_TELEGRAPH_BONUS,
  O2_TANK2_BONUS, O2_TANK_BONUS, OXYGEN_DRAIN, OXYGEN_MAX, OXYGEN_REFILL, OXYGEN_WARN, POLE_CLAMP,
  RANKS, RECYCLER_REDUCTION, SCANNER_RANGE, SCOOP_RADIUS, SHIP_ACCEL_K, SHIP_BOOST_SPEED,
  SHIP_LEVEL_K, SHIP_PITCH_RATE, SHIP_REVERSE_SPEED, SHIP_ROLL_RATE, SHIP_SPEED, SHIP_YAW_RATE,
  SPRINT_MULTIPLIER, STORM_DRAIN_MULT, STORM_DURATION, STORM_PERIOD, STORM_PUSH, STORM_WARN_LEAD,
  STORM_WARN_LEAD_BONUS, STRIDE_BONUS, SUFFOCATION_DAMAGE, SUN_RADIUS, SURFACE_RADIUS, TAU,
  THRUSTER_BONUS, TRANSITION_TIME, WALK_SPEED, WIDE_SCOOP_BONUS,
} from './config.ts'
import { RELIC_BY_PLANET, SHOP_BY_ID } from './economy.ts'
import { quatForward, quatFromBasis, quatIntegrate, quatNlerp, quatToFlightAngles } from './orient.ts'
import { PLANETS, landerSite, planetById } from './planets.ts'
import { nextRandom, randomBetween } from './rng.ts'
import type {
  Game, GameEvent, HazardState, Input, Junk, JunkClass, PlayMode, Quat, Rank, Vec3,
} from './types.ts'

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function wrapAngle(angle: number): number {
  let value = angle % TAU
  if (value > Math.PI) value -= TAU
  if (value < -Math.PI) value += TAU
  return value
}

/** Great-circle distance between two surface points, in surface units. */
export function latLonDistance(
  a: { lat: number; lon: number }, b: { lat: number; lon: number }, radius = SURFACE_RADIUS,
): number {
  const dLat = a.lat - b.lat
  const dLon = wrapAngle(a.lon - b.lon)
  const x = dLon * Math.cos((a.lat + b.lat) / 2)
  return Math.hypot(x, dLat) * radius
}

/** Compass bearing from a to b: 0 = north, positive = east. */
export function bearingTo(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLon = wrapAngle(b.lon - a.lon)
  const y = Math.sin(dLon) * Math.cos(b.lat)
  const x = Math.cos(a.lat) * Math.sin(b.lat) - Math.sin(a.lat) * Math.cos(b.lat) * Math.cos(dLon)
  return Math.atan2(y, x)
}

export function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Surface lat/lon to a point on the planet sphere, in space-map coordinates. */
export function surfaceToWorld(
  centre: Vec3, lat: number, lon: number, radius: number, target: Vec3 = { x: 0, y: 0, z: 0 },
): Vec3 {
  const cosLat = Math.cos(lat)
  target.x = centre.x + radius * cosLat * Math.cos(lon)
  target.y = centre.y + radius * Math.sin(lat)
  target.z = centre.z + radius * cosLat * Math.sin(lon)
  return target
}

// ------------------------------------------------------------- upgrade maths

export function hasUpgrade(game: Game, id: string): boolean {
  return game.upgrades.includes(id)
}

/** Relic tools are unlocked by delivering a relic, never bought. */
export function hasRelic(game: Game, tool: string): boolean {
  return game.relicTools.includes(tool)
}

export const maxOxygen = (game: Game) =>
  OXYGEN_MAX
  + (hasUpgrade(game, 'o2tank') ? O2_TANK_BONUS : 0)
  + (hasUpgrade(game, 'o2tank2') ? O2_TANK2_BONUS : 0)
export const carrySlots = (game: Game) => CARRY_SLOTS + (hasUpgrade(game, 'cargogloves') ? CARGO_GLOVES_BONUS : 0)
export const holdSlots = (game: Game) => HOLD_SLOTS + (hasUpgrade(game, 'cargoracks') ? CARGO_RACKS_BONUS : 0)
export const scoopRadius = (game: Game) => SCOOP_RADIUS + (hasUpgrade(game, 'widescoop') ? WIDE_SCOOP_BONUS : 0)
export const shipSpeed = (game: Game) => SHIP_SPEED * (hasUpgrade(game, 'thrusterkit') ? 1 + THRUSTER_BONUS : 1)
export const boostSpeed = (game: Game) => SHIP_BOOST_SPEED * (hasUpgrade(game, 'thrusterkit') ? 1 + THRUSTER_BONUS : 1)

/** Magboots, Surefoot Stride and sprinting all stack on the base walk speed. */
export function walkSpeed(game: Game, sprinting: boolean): number {
  let speed = WALK_SPEED
  if (hasUpgrade(game, 'magboots')) speed *= 1 + MAGBOOTS_BONUS
  if (hasRelic(game, 'stride')) speed *= 1 + STRIDE_BONUS
  return speed * (sprinting ? SPRINT_MULTIPLIER : 1)
}

export const hopSpeed = (game: Game) => HOP_SPEED * (hasUpgrade(game, 'gravharness') ? 1 + GRAV_HOP_BONUS : 1)

/** The impact speed that still counts as a soft landing. */
export function hardLandSpeed(game: Game): number {
  let limit = HARD_LAND_SPEED
  if (hasUpgrade(game, 'gravharness')) limit *= 1 + GRAV_LAND_BONUS
  if (hasRelic(game, 'stride')) limit *= 1 + GRAV_LAND_BONUS
  return limit
}

export const hazardDamage = (game: Game, base: number) =>
  base * (hasUpgrade(game, 'hazardweave') ? 1 - HAZARD_WEAVE_REDUCTION : 1)

export const oxygenDrainRate = (game: Game, storming: boolean) =>
  OXYGEN_DRAIN
  * (hasUpgrade(game, 'recycler') ? 1 - RECYCLER_REDUCTION : 1)
  * (storming ? STORM_DRAIN_MULT : 1)

export const dockRadius = (game: Game) => (hasUpgrade(game, 'dockingassist') ? DOCK_ASSIST_RADIUS : DOCK_RADIUS)
export const scannerRange = (game: Game) => (hasUpgrade(game, 'scanner') ? SCANNER_RANGE : 0)

// -------------------------------------------------------------------- counts

export function carryCount(game: Game): number {
  let count = 0
  for (const item of game.junk) if (item.status === 'carried') count++
  return count
}

export function holdCount(game: Game): number {
  let count = 0
  for (const item of game.junk) if (item.status === 'hold') count++
  return count
}

export function planetJunkTotal(game: Game, planetId = game.planetId): number {
  let count = 0
  for (const item of game.junk) if (item.planet === planetId) count++
  return count
}

export function deliveredCount(game: Game, planetId = game.planetId): number {
  let count = 0
  for (const item of game.junk) if (item.planet === planetId && item.status === 'delivered') count++
  return count
}

export function remainingCount(game: Game, planetId: number): number {
  return planetJunkTotal(game, planetId) - deliveredCount(game, planetId)
}

export function allPlanetsClean(game: Game): boolean {
  for (const planet of PLANETS) {
    if (planetJunkTotal(game, planet.id) === 0) continue
    if (remainingCount(game, planet.id) > 0) return false
  }
  return true
}

export interface ProgressSummary {
  planetName: string
  delivered: number
  total: number
  hold: number
  holdCap: number
  carry: number
  carryCap: number
  planetsCleaned: number
  planetCount: number
  systemDelivered: number
  systemTotal: number
}

export function progressSummary(game: Game): ProgressSummary {
  let systemDelivered = 0
  let systemTotal = 0
  for (const planet of PLANETS) {
    systemDelivered += deliveredCount(game, planet.id)
    systemTotal += planetJunkTotal(game, planet.id)
  }
  return {
    planetName: planetById(game.planetId).name,
    delivered: deliveredCount(game),
    total: planetJunkTotal(game),
    hold: holdCount(game),
    holdCap: holdSlots(game),
    carry: carryCount(game),
    carryCap: carrySlots(game),
    planetsCleaned: game.planetsCleaned,
    planetCount: PLANETS.length,
    systemDelivered,
    systemTotal,
  }
}

/** Plan §5.6 ranks, tuned so a full three-planet run can actually reach LEGEND. */
export function rankForScore(score: number): Rank {
  for (const entry of RANKS) if (score >= entry.min) return entry.name
  return 'BRONZE'
}

export function rank(game: Game): Rank {
  return rankForScore(game.score)
}

/** Per-planet junk still waiting, for the Nav Computer readout. */
export function systemReport(game: Game): { id: number; name: string; remaining: number; total: number }[] | null {
  if (!hasUpgrade(game, 'navcomputer')) return null
  return PLANETS.map(planet => ({
    id: planet.id,
    name: planet.name,
    remaining: remainingCount(game, planet.id),
    total: planetJunkTotal(game, planet.id),
  }))
}

export interface Ping {
  lat: number
  lon: number
  cls: JunkClass
  /** radians relative to the janitor's facing, 0 = straight ahead */
  bearing: number
  distance: number
}

/**
 * Junk Scanner pings ground junk inside its range; the Eye in the Sky relic
 * tracks every piece on the planet (plan §5.5).
 */
export function scannerPings(game: Game): Ping[] {
  if (game.mode !== 'surface') return []
  const eye = hasRelic(game, 'eye')
  const range = scannerRange(game)
  if (!eye && range <= 0) return []
  const pings: Ping[] = []
  for (const item of game.junk) {
    if (item.status !== 'ground' || item.planet !== game.planetId) continue
    const distance = latLonDistance(game.player, item)
    if (!eye && distance > range) continue
    pings.push({
      lat: item.lat,
      lon: item.lon,
      cls: item.cls,
      bearing: wrapAngle(bearingTo(game.player, item) - game.player.facing),
      distance,
    })
  }
  return pings
}

// ------------------------------------------------------------------- events

function emitSurface(
  game: Game, kind: GameEvent['kind'], text: string, amount: number,
  at: { lat: number; lon: number; h: number },
) {
  game.events.push({
    kind, text, amount, place: 'surface', lat: at.lat, lon: at.lon, h: at.h, x: 0, y: 0, z: 0,
  })
}

function emitSpace(game: Game, kind: GameEvent['kind'], text: string, amount: number, at: Vec3) {
  game.events.push({
    kind, text, amount, place: 'space', lat: 0, lon: 0, h: 0, x: at.x, y: at.y, z: at.z,
  })
}

const playerPoint = (game: Game) => ({ lat: game.player.lat, lon: game.player.lon, h: game.player.h })
const shipPoint = (game: Game) => ({ x: game.ship.x, y: game.ship.y, z: game.ship.z })

// -------------------------------------------------------------------- setup

export interface CreateOptions {
  seed?: number
  planetId?: number
}

function freshHazards(): HazardState {
  return {
    meteorTimer: 0,
    meteorTelegraph: -1,
    meteorDelay: METEOR_TELEGRAPH,
    meteorLat: 0,
    meteorLon: 0,
    stormTimer: STORM_PERIOD,
    stormActive: false,
    stormTime: 0,
    stormWarned: false,
    stormIntensity: 0,
    stormWind: 1,
  }
}

const IDENTITY_Q: Quat = { x: 0, y: 0, z: 0, w: 1 }

export function createGame(options: CreateOptions = {}): Game {
  const seed = (options.seed ?? Date.now()) >>> 0
  const game: Game = {
    seed,
    rngState: seed,
    phase: 'ready',
    outcome: 'none',
    mode: 'surface',
    transition: null,
    time: 0,
    score: 0,
    credits: 0,
    health: HEALTH_MAX,
    oxygen: OXYGEN_MAX,
    lowOxygenWarned: false,
    oxygenEmptyWarned: false,
    atLander: true,
    scrapeTimer: 0,
    planetId: options.planetId ?? 0,
    player: { lat: 0, lon: 0, h: 0, vH: 0, vN: 0, vE: 0, facing: 0, hopCooldown: 0 },
    ship: {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      q: { ...IDENTITY_Q }, speed: 0, thrust: 0, boosting: false,
    },
    hazards: freshHazards(),
    earthAngle: 0,
    issAngle: 0,
    moonAngle: 0,
    marsAngle: 0,
    planetPos: PLANETS.map(() => ({ x: 0, y: 0, z: 0 })),
    issPos: { x: 0, y: 0, z: 0 },
    dockPos: { x: 0, y: 0, z: 0 },
    moonPos: { x: 0, y: 0, z: 0 },
    junk: [],
    upgrades: [],
    relicTools: [],
    delivered: 0,
    bestBatch: 0,
    trips: 0,
    rescued: false,
    planetsCleaned: 0,
    events: [],
    nextId: 0,
  }
  game.earthAngle = randomBetween(game, 0, TAU)
  game.issAngle = randomBetween(game, 0, TAU)
  game.moonAngle = randomBetween(game, 0, TAU)
  game.marsAngle = randomBetween(game, 0, TAU)
  buildJunk(game)
  computeBodies(game)
  resetHazards(game)
  placePlayerAtLander(game)
  placeShipOnPad(game)
  return game
}

function buildJunk(game: Game) {
  for (const planet of PLANETS) {
    const lander = landerSite(planet.id)
    const relicIndex = Math.floor(nextRandom(game) * planet.junkCount)
    for (let i = 0; i < planet.junkCount; i++) {
      const relic = i === relicIndex
      const roll = nextRandom(game)
      const cls: JunkClass = relic ? 'relic' : roll < 0.58 ? 'scrap' : roll < 0.86 ? 'tech' : 'hazardous'
      // roughly a third of the pieces scatter further out, the rest cluster near the lander
      const spread = relic ? 1 : nextRandom(game) < 0.34 ? 1 : 0.45
      let lat = clamp(
        planet.landerLat + randomBetween(game, -1, 1) * planet.spread.lat * spread,
        -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05,
      )
      const lon = wrapAngle(planet.landerLon + randomBetween(game, -1, 1) * planet.spread.lon * spread)
      const item: Junk = {
        id: game.nextId++,
        planet: planet.id,
        cls,
        lat,
        lon,
        status: 'ground',
        spin: randomBetween(game, 0.3, 1.6),
        yaw: randomBetween(game, 0, TAU),
      }
      // never drop junk onto the lander pad itself; relics keep their distance
      const minimum = relic ? LANDER_RING_RADIUS + 8 : LANDER_RING_RADIUS + 3
      if (latLonDistance(item, lander) < minimum) {
        lat = clamp(lat + (relic ? 0.34 : 0.28), -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05)
        item.lat = lat
        if (latLonDistance(item, lander) < minimum) {
          item.lon = wrapAngle(item.lon + 0.3)
        }
      }
      game.junk.push(item)
    }
  }
}

function orbitPoint(centre: Vec3, radius: number, angle: number, target: Vec3): Vec3 {
  target.x = centre.x + radius * Math.cos(angle)
  target.y = centre.y
  target.z = centre.z + radius * Math.sin(angle)
  return target
}

export function computeBodies(game: Game) {
  orbitPoint({ x: 0, y: 0, z: 0 }, PLANETS[0].orbit, game.earthAngle, game.planetPos[0])
  orbitPoint(game.planetPos[0], PLANETS[1].orbit, game.moonAngle, game.planetPos[1])
  orbitPoint({ x: 0, y: 0, z: 0 }, PLANETS[2].orbit, game.marsAngle, game.planetPos[2])
  game.moonPos.x = game.planetPos[1].x
  game.moonPos.y = game.planetPos[1].y
  game.moonPos.z = game.planetPos[1].z

  orbitPoint(game.planetPos[0], ISS_ORBIT, game.issAngle, game.issPos)
  orbitPoint(game.planetPos[0], ISS_ORBIT + ISS_DOCK_OFFSET, game.issAngle, game.dockPos)
}

/** Called on start and after every landing: hazards get a fresh cycle per visit. */
export function resetHazards(game: Game) {
  const hazard = planetById(game.planetId).hazard
  const hazards = game.hazards
  hazards.meteorTelegraph = -1
  hazards.meteorDelay = METEOR_TELEGRAPH
  hazards.meteorTimer = hazard === 'meteor' ? randomBetween(game, METEOR_INTERVAL_MIN, METEOR_INTERVAL_MAX) : Infinity
  hazards.stormActive = false
  hazards.stormTime = 0
  hazards.stormWarned = false
  hazards.stormIntensity = 0
  hazards.stormTimer = hazard === 'storm' ? STORM_PERIOD : Infinity
  hazards.stormWind = nextRandom(game) < 0.5 ? -1 : 1
}

export function placePlayerAtLander(game: Game) {
  const site = landerSite(game.planetId)
  const player = game.player
  player.lat = site.lat
  player.lon = site.lon
  player.h = 0
  player.vH = 0
  player.vN = 0
  player.vE = 0
  player.hopCooldown = 0
  player.facing = 0
  game.atLander = true
}

const SCRATCH_UP: Vec3 = { x: 0, y: 0, z: 0 }
const SCRATCH_TANGENT: Vec3 = { x: 0, y: 0, z: 0 }

/** Park the tug on the pad, nose pointed along the planet's orbital motion. */
export function placeShipOnPad(game: Game) {
  const planet = planetById(game.planetId)
  const centre = game.planetPos[game.planetId]
  const site = landerSite(game.planetId)
  const pad = surfaceToWorld(centre, site.lat, site.lon, planet.spaceRadius + 12)
  const ship = game.ship
  ship.x = pad.x
  ship.y = pad.y
  ship.z = pad.z
  ship.vx = 0
  ship.vy = 0
  ship.vz = 0
  ship.speed = 0
  ship.thrust = 0
  ship.boosting = false

  const up = SCRATCH_UP
  up.x = pad.x - centre.x
  up.y = pad.y - centre.y
  up.z = pad.z - centre.z
  const upLength = Math.hypot(up.x, up.y, up.z) || 1
  up.x /= upLength
  up.y /= upLength
  up.z /= upLength
  // prograde = world up cross radial up
  const tangent = SCRATCH_TANGENT
  tangent.x = -up.z
  tangent.y = 0
  tangent.z = up.x
  const tangentLength = Math.hypot(tangent.x, tangent.y, tangent.z) || 1
  tangent.x /= tangentLength
  tangent.z /= tangentLength
  ship.q = quatFromBasis(tangent, up)
}

// ------------------------------------------------------------------ queries

export const nearLander = (game: Game): boolean =>
  latLonDistance(game.player, landerSite(game.planetId)) <= LANDER_RING_RADIUS

export function canDock(game: Game): boolean {
  return game.mode === 'space' && !game.transition && distance3(game.ship, game.dockPos) <= dockRadius(game)
}

/** The landable planet the ship is currently inside the landing zone of, or -1. */
export function landTarget(game: Game): number {
  if (game.mode !== 'space' || game.transition) return -1
  if (game.ship.speed > LAND_MAX_SPEED) return -1
  let best = -1
  let bestDistance = Infinity
  for (const planet of PLANETS) {
    if (!planet.landable) continue
    const distance = distance3(game.ship, game.planetPos[planet.id])
    if (distance > planet.spaceRadius + LAND_ZONE_HEIGHT) continue
    if (distance < bestDistance) {
      bestDistance = distance
      best = planet.id
    }
  }
  return best
}

export function canLand(game: Game): boolean {
  return landTarget(game) >= 0
}

export interface Objective {
  kind: 'iss' | 'planet' | 'none'
  planetId: number
  label: string
}

/** Where the janitor should be heading next (plan §5.1 compass / §5.2 HUD). */
export function objective(game: Game): Objective {
  if (holdCount(game) > 0 || carryCount(game) > 0) {
    return { kind: 'iss', planetId: 0, label: 'ISS' }
  }
  let best = -1
  let bestDistance = Infinity
  for (const planet of PLANETS) {
    if (remainingCount(game, planet.id) <= 0) continue
    const distance = distance3(game.ship, game.planetPos[planet.id])
    if (distance < bestDistance) {
      bestDistance = distance
      best = planet.id
    }
  }
  if (best < 0) return { kind: 'none', planetId: -1, label: 'SYSTEM CLEAN' }
  return { kind: 'planet', planetId: best, label: planetById(best).name.toUpperCase() }
}

export function contextLabel(game: Game): string {
  if (game.transition) return ''
  if (game.mode === 'surface') {
    if (!nearLander(game)) return 'RETURN TO LANDER'
    return carryCount(game) > 0 && holdCount(game) < holdSlots(game) ? 'DEPOSIT' : 'TAKE OFF'
  }
  if (game.mode === 'space') {
    if (canDock(game)) return 'DOCK'
    if (canLand(game)) return 'LAND'
    const target = objective(game)
    return target.kind === 'iss' ? 'FLY TO THE ISS' : `FLY TO ${target.label}`
  }
  return 'SHOP'
}

// ------------------------------------------------------------------ actions

export function deposit(game: Game): boolean {
  if (game.phase !== 'playing' || game.mode !== 'surface' || !nearLander(game)) return false
  const capacity = holdSlots(game)
  let stored = holdCount(game)
  let stowed = 0
  for (const item of game.junk) {
    if (stored >= capacity) break
    if (item.status !== 'carried') continue
    item.status = 'hold'
    stored++
    stowed++
  }
  if (stowed === 0) return false
  emitSurface(game, 'deposit', `STOWED ${stowed} PCS - HOLD ${stored}/${capacity}`, stowed, playerPoint(game))
  return true
}

export function takeOff(game: Game): boolean {
  if (game.phase !== 'playing' || game.mode !== 'surface' || game.transition) return false
  if (!nearLander(game)) return false
  game.transition = { kind: 'takeoff', t: 0, duration: TRANSITION_TIME }
  emitSurface(game, 'takeoff', 'LIFT OFF', 0, playerPoint(game))
  return true
}

export function land(game: Game): boolean {
  if (game.phase !== 'playing' || game.mode !== 'space' || game.transition) return false
  const target = landTarget(game)
  if (target < 0) return false
  game.planetId = target
  game.transition = { kind: 'landing', t: 0, duration: TRANSITION_TIME }
  emitSpace(game, 'land', `DESCENDING TO ${planetById(target).name.toUpperCase()}`, 0, shipPoint(game))
  return true
}

export function dock(game: Game): boolean {
  if (game.phase !== 'playing' || game.mode !== 'space' || game.transition) return false
  if (!canDock(game)) return false
  game.mode = 'docked'
  game.trips++
  snapShipToDock(game)
  emitSpace(game, 'dock', 'DOCKED AT THE ISS', 0, shipPoint(game))
  deliverAll(game)
  return true
}

export function undock(game: Game): boolean {
  if (game.phase !== 'playing' || game.mode !== 'docked') return false
  game.mode = 'space'
  const dx = game.ship.x - game.planetPos[0].x
  const dz = game.ship.z - game.planetPos[0].z
  const length = Math.max(1e-6, Math.hypot(dx, dz))
  game.ship.vx = (dx / length) * 8
  game.ship.vy = 0
  game.ship.vz = (dz / length) * 8
  game.ship.speed = Math.hypot(game.ship.vx, game.ship.vy, game.ship.vz)
  // face away from Earth so the tug leaves the hatch nose first
  game.ship.q = quatFromBasis({ x: dx / length, y: 0, z: dz / length }, { x: 0, y: 1, z: 0 })
  emitSpace(game, 'undock', 'UNDOCKED', 0, shipPoint(game))
  return true
}

export function contextAction(game: Game): boolean {
  if (game.phase !== 'playing' || game.transition) return false
  if (game.mode === 'surface') {
    if (!nearLander(game)) {
      emitSurface(game, 'block', 'LANDER OUT OF RANGE', 0, playerPoint(game))
      return false
    }
    if (carryCount(game) > 0 && holdCount(game) < holdSlots(game)) return deposit(game)
    return takeOff(game)
  }
  if (game.mode === 'space') {
    if (canDock(game)) return dock(game)
    if (canLand(game)) return land(game)
    emitSpace(game, 'block', 'NOTHING IN RANGE', 0, shipPoint(game))
    return false
  }
  return undock(game)
}

export function canBuy(game: Game, id: string): { ok: boolean; reason: string; item?: ReturnType<typeof shopItem> } {
  const item = shopItem(id)
  if (!item) return { ok: false, reason: 'NO SUCH ITEM' }
  if (game.mode !== 'docked') return { ok: false, reason: 'ONLY AT THE ISS', item }
  if (hasUpgrade(game, id) && !item.repeatable) return { ok: false, reason: 'INSTALLED', item }
  if (item.requires && !hasUpgrade(game, item.requires)) {
    return { ok: false, reason: `NEEDS ${shopItem(item.requires)?.name.toUpperCase() ?? 'PREREQUISITE'}`, item }
  }
  if (game.credits < item.cost) return { ok: false, reason: 'NOT ENOUGH CREDITS', item }
  return { ok: true, reason: 'BUY', item }
}

function shopItem(id: string) {
  return SHOP_BY_ID[id]
}

export function buyItem(game: Game, id: string): boolean {
  if (game.phase !== 'playing') return false
  const check = canBuy(game, id)
  if (!check.ok || !check.item) {
    if (game.mode === 'docked' && check.reason === 'NOT ENOUGH CREDITS') {
      emitSpace(game, 'block', 'NOT ENOUGH CREDITS', 0, shipPoint(game))
    }
    return false
  }
  const item = check.item
  game.credits -= item.cost
  game.upgrades.push(id)
  if (id === 'o2tank') game.oxygen = Math.min(maxOxygen(game), game.oxygen + O2_TANK_BONUS)
  if (id === 'o2tank2') game.oxygen = Math.min(maxOxygen(game), game.oxygen + O2_TANK2_BONUS)
  emitSpace(game, 'buy', `${item.name.toUpperCase()} INSTALLED`, item.cost, shipPoint(game))
  return true
}

export function deliverValue(items: { cls: JunkClass }[], holdCapacity: number) {
  let value = 0
  for (const item of items) value += JUNK_POINTS[item.cls]
  let bonusRate = 0
  if (items.length >= BATCH_BONUS_SIZE) bonusRate += BATCH_BONUS
  if (items.length >= holdCapacity) bonusRate += FULL_HOLD_BONUS
  return { value, bonusRate, credits: Math.round(value * (1 + bonusRate)) }
}

function deliverAll(game: Game): number {
  const batch = game.junk.filter(item => item.status === 'hold' || item.status === 'carried')
  if (batch.length === 0) return 0
  const before = PLANETS.map(planet => deliveredCount(game, planet.id))
  const payout = deliverValue(batch, holdSlots(game))
  for (const item of batch) item.status = 'delivered'
  game.credits += payout.credits
  game.score += payout.credits
  game.delivered += batch.length
  game.bestBatch = Math.max(game.bestBatch, batch.length)
  emitSpace(game, 'deliver', `DELIVERED ${batch.length} PCS`, payout.credits, shipPoint(game))
  unlockRelics(game, batch)
  PLANETS.forEach((planet, index) => {
    const total = planetJunkTotal(game, planet.id)
    if (total === 0 || before[index] >= total) return
    if (deliveredCount(game, planet.id) < total) return
    game.score += CLEAN_BONUS
    game.planetsCleaned++
    emitSpace(game, 'clean', `${planet.name.toUpperCase()} FULLY CLEANED`, CLEAN_BONUS, shipPoint(game))
  })
  checkWin(game)
  return batch.length
}

function unlockRelics(game: Game, batch: Junk[]) {
  for (const item of batch) {
    if (item.cls !== 'relic') continue
    const relic = RELIC_BY_PLANET[item.planet]
    if (!relic || game.relicTools.includes(relic.tool)) continue
    game.relicTools.push(relic.tool)
    game.delivered += 0
    emitSpace(game, 'relic', `${relic.toolName.toUpperCase()} ONLINE`, JUNK_POINTS.relic, shipPoint(game))
  }
}

function checkWin(game: Game) {
  if (!allPlanetsClean(game)) return
  game.phase = 'finished'
  game.outcome = 'won'
  emitSpace(game, 'win', 'SYSTEM RESTORED', game.score, shipPoint(game))
}

function knockout(game: Game) {
  if (hasUpgrade(game, 'beacon')) {
    game.upgrades = game.upgrades.filter(id => id !== 'beacon')
    game.rescued = true
    game.health = Math.round(HEALTH_MAX * 0.5)
    game.oxygen = OXYGEN_WARN
    if (game.mode !== 'surface') {
      game.mode = 'surface'
      game.transition = null
      resetHazards(game)
    }
    placePlayerAtLander(game)
    emitSurface(game, 'rescue', 'EMERGENCY BEACON FIRED - RESCUED', 0, playerPoint(game))
    return
  }
  game.health = 0
  game.phase = 'finished'
  game.outcome = 'lost'
  emitSurface(game, 'lose', 'SUIT FAILURE', 0, playerPoint(game))
}

function damageSuit(game: Game, amount: number, label: string, at: { lat: number; lon: number; h: number }) {
  game.health = Math.max(0, game.health - amount)
  emitSurface(game, 'block', label, amount, at)
  if (game.health <= 0) knockout(game)
}

// -------------------------------------------------------------- transitions

function finishTransition(game: Game) {
  const kind = game.transition?.kind
  game.transition = null
  if (kind === 'takeoff') {
    game.mode = 'space'
    placeShipOnPad(game)
  } else if (kind === 'landing') {
    game.mode = 'surface'
    resetHazards(game)
    placePlayerAtLander(game)
    emitSurface(game, 'land', `TOUCHDOWN - ${planetById(game.planetId).name.toUpperCase()}`, 0, playerPoint(game))
    const target = objective(game)
    emitSurface(
      game, 'hint',
      target.kind === 'planet'
        ? `${remainingCount(game, game.planetId)} PCS TO SWEEP - ${target.label} NEXT`
        : 'ALL WORLDS SWEPT',
      0, playerPoint(game),
    )
  }
}

function snapShipToDock(game: Game) {
  const ship = game.ship
  ship.x = game.dockPos.x
  ship.y = game.dockPos.y
  ship.z = game.dockPos.z
  ship.vx = 0
  ship.vy = 0
  ship.vz = 0
  ship.speed = 0
  ship.thrust = 0
  ship.boosting = false
}

// ------------------------------------------------------------------ updates

function updateBodies(game: Game, dt: number) {
  game.earthAngle = wrapAngle(game.earthAngle + PLANETS[0].orbitRate * dt)
  game.moonAngle = wrapAngle(game.moonAngle + PLANETS[1].orbitRate * dt)
  game.marsAngle = wrapAngle(game.marsAngle + PLANETS[2].orbitRate * dt)
  game.issAngle = wrapAngle(game.issAngle + ISS_ORBIT_RATE * dt)
  computeBodies(game)
}

function updateVacuum(game: Game) {
  const slots = carrySlots(game)
  let carried = carryCount(game)
  if (carried >= slots) return
  const range = scoopRadius(game)
  for (const item of game.junk) {
    if (carried >= slots) break
    if (item.status !== 'ground' || item.planet !== game.planetId) continue
    const ground = latLonDistance(game.player, item)
    if (Math.hypot(ground, game.player.h) > range) continue
    item.status = 'carried'
    carried++
    emitSurface(game, 'pickup', '', JUNK_POINTS[item.cls], { lat: item.lat, lon: item.lon, h: 0 })
  }
}

function updateOxygen(game: Game, dt: number) {
  const atLander = nearLander(game)
  if (atLander && !game.atLander) emitSurface(game, 'refill', 'OXYGEN REFILLING', 0, playerPoint(game))
  game.atLander = atLander
  if (atLander) {
    game.oxygen = Math.min(maxOxygen(game), game.oxygen + OXYGEN_REFILL * dt)
    game.lowOxygenWarned = false
    game.oxygenEmptyWarned = false
    return
  }
  game.oxygen = Math.max(0, game.oxygen - oxygenDrainRate(game, game.hazards.stormActive) * dt)
  if (game.oxygen <= 0) {
    if (!game.oxygenEmptyWarned) {
      game.oxygenEmptyWarned = true
      emitSurface(game, 'oxygen', 'OXYGEN EMPTY - SUFFOCATING', 0, playerPoint(game))
    }
    game.health = Math.max(0, game.health - SUFFOCATION_DAMAGE * dt)
    if (game.health <= 0) knockout(game)
  } else if (game.oxygen <= OXYGEN_WARN && !game.lowOxygenWarned) {
    game.lowOxygenWarned = true
    emitSurface(game, 'oxygen', 'OXYGEN LOW - HEAD FOR THE LANDER', 0, playerPoint(game))
  }
}

function updateSurface(game: Game, dt: number, input: Input) {
  const planet = planetById(game.planetId)
  const player = game.player
  const length = Math.hypot(input.x, input.y)
  const speed = walkSpeed(game, input.boost)
  const onGround = player.h <= 0 && player.vH <= 0

  if (length > 0.12) {
    const nx = input.x / Math.max(1, length)
    const ny = input.y / Math.max(1, length)
    player.facing = Math.atan2(nx, ny)
    if (onGround) {
      player.vN = ny * speed
      player.vE = nx * speed
    } else {
      const k = Math.min(1, AIR_CONTROL_K * dt)
      player.vN += (ny * speed - player.vN) * k
      player.vE += (nx * speed - player.vE) * k
    }
  } else if (onGround) {
    player.vN = 0
    player.vE = 0
  }

  player.lat = clamp(player.lat + (player.vN * dt) / SURFACE_RADIUS, -POLE_CLAMP, POLE_CLAMP)
  const cosLat = Math.max(0.3, Math.cos(player.lat))
  player.lon = wrapAngle(player.lon + (player.vE * dt) / (SURFACE_RADIUS * cosLat))

  // storm wind shoves the janitor sideways while a dust storm blows
  if (game.hazards.stormActive && game.hazards.stormIntensity > 0.05) {
    const push = STORM_PUSH * game.hazards.stormIntensity * game.hazards.stormWind * dt
    player.lon = wrapAngle(player.lon + push / (SURFACE_RADIUS * cosLat))
  }

  player.hopCooldown = Math.max(0, player.hopCooldown - dt)
  if (input.hop && onGround && player.hopCooldown <= 0) {
    player.vH = hopSpeed(game)
    player.hopCooldown = HOP_COOLDOWN
  }

  if (player.h > 0 || player.vH > 0) {
    player.vH -= GRAVITY_BASE * planet.gravity * dt
    player.h += player.vH * dt
    if (player.h <= 0) {
      const impact = -player.vH
      player.h = 0
      player.vH = 0
      const limit = hardLandSpeed(game)
      if (impact > limit) damageSuit(game, HARD_LAND_DAMAGE, 'HARD LANDING', playerPoint(game))
      else emitSurface(game, 'land', '', 0, playerPoint(game))
    }
  }

  updateVacuum(game)
  if (game.phase === 'playing') updateOxygen(game, dt)
}

/**
 * Moon: meteor showers telegraphed 2.5 s ahead (5.5 s with Storm Sense).
 * Mars: dust storms every ~45 s that thicken the air and shove you sideways.
 */
export function updateHazards(game: Game, dt: number) {
  const planet = planetById(game.planetId)
  const hazards = game.hazards

  if (planet.hazard === 'meteor') {
    if (hazards.meteorTelegraph >= 0) {
      hazards.meteorTelegraph += dt
      if (hazards.meteorTelegraph >= hazards.meteorDelay) {
        hazards.meteorTelegraph = -1
        hazards.meteorTimer = randomBetween(game, METEOR_INTERVAL_MIN, METEOR_INTERVAL_MAX)
        const distance = latLonDistance(game.player, { lat: hazards.meteorLat, lon: hazards.meteorLon })
        emitSurface(game, 'meteor', 'METEOR IMPACT', 0, {
          lat: hazards.meteorLat, lon: hazards.meteorLon, h: 0,
        })
        if (distance <= METEOR_RADIUS && game.player.h < 4 && game.phase === 'playing') {
          damageSuit(game, hazardDamage(game, METEOR_DAMAGE), 'METEOR HIT', playerPoint(game))
        }
      }
    } else if (game.phase === 'playing') {
      hazards.meteorTimer -= dt
      if (hazards.meteorTimer <= 0) {
        hazards.meteorDelay = METEOR_TELEGRAPH + (hasRelic(game, 'stormsense') ? METEOR_TELEGRAPH_BONUS : 0)
        hazards.meteorTelegraph = 0
        const cosLat = Math.max(0.35, Math.cos(game.player.lat))
        hazards.meteorLat = clamp(
          game.player.lat + randomBetween(game, -1, 1) * (METEOR_RANGE / SURFACE_RADIUS),
          -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05,
        )
        hazards.meteorLon = wrapAngle(
          game.player.lon + randomBetween(game, -1, 1) * (METEOR_RANGE / (SURFACE_RADIUS * cosLat)),
        )
        emitSurface(
          game, 'hint',
          hasRelic(game, 'stormsense') ? 'STORM SENSE: METEOR INBOUND' : 'METEOR INBOUND',
          0, playerPoint(game),
        )
      }
    }
  } else {
    hazards.meteorTelegraph = -1
  }

  if (planet.hazard === 'storm') {
    if (hazards.stormActive) {
      hazards.stormTime += dt
      if (hazards.stormTime >= STORM_DURATION) {
        hazards.stormActive = false
        hazards.stormTime = 0
        hazards.stormTimer = STORM_PERIOD
        emitSurface(game, 'storm', 'STORM CLEARING', 0, playerPoint(game))
      }
    } else {
      if (hazards.stormTimer === Infinity) hazards.stormTimer = STORM_PERIOD
      hazards.stormTimer -= dt
      const lead = STORM_WARN_LEAD + (hasRelic(game, 'stormsense') ? STORM_WARN_LEAD_BONUS : 0)
      if (!hazards.stormWarned && hazards.stormTimer <= lead) {
        hazards.stormWarned = true
        emitSurface(
          game, 'hint',
          hasRelic(game, 'stormsense') ? 'STORM SENSE: DUST STORM INBOUND' : 'DUST STORM INBOUND',
          0, playerPoint(game),
        )
      }
      if (hazards.stormTimer <= 0) {
        hazards.stormActive = true
        hazards.stormTime = 0
        hazards.stormWarned = false
        hazards.stormWind = randomBetween(game, -1, 1) < 0 ? -1 : 1
        emitSurface(game, 'storm', 'DUST STORM - OXYGEN DRAINING FASTER', 0, playerPoint(game))
      }
    }
  } else if (hazards.stormActive) {
    hazards.stormActive = false
    hazards.stormTime = 0
  }

  const target = hazards.stormActive ? 1 : 0
  const rate = dt * 0.7
  hazards.stormIntensity += clamp(target - hazards.stormIntensity, -rate, rate)
}

const SCRATCH_FORWARD: Vec3 = { x: 0, y: 0, z: 0 }

function collideBodies(game: Game) {
  const ship = game.ship
  const bodies: { x: number; y: number; z: number; radius: number }[] = [
    { x: 0, y: 0, z: 0, radius: SUN_RADIUS + BODY_CLEARANCE * 2 },
  ]
  for (const planet of PLANETS) {
    const position = game.planetPos[planet.id]
    bodies.push({
      x: position.x,
      y: position.y,
      z: position.z,
      radius: planet.spaceRadius + BODY_CLEARANCE,
    })
  }
  for (const body of bodies) {
    const dx = ship.x - body.x
    const dy = ship.y - body.y
    const dz = ship.z - body.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance >= body.radius || distance < 1e-6) continue
    const nx = dx / distance
    const ny = dy / distance
    const nz = dz / distance
    ship.x = body.x + nx * body.radius
    ship.y = body.y + ny * body.radius
    ship.z = body.z + nz * body.radius
    const normalVelocity = ship.vx * nx + ship.vy * ny + ship.vz * nz
    if (normalVelocity < 0) {
      ship.vx -= nx * normalVelocity * 1.35
      ship.vy -= ny * normalVelocity * 1.35
      ship.vz -= nz * normalVelocity * 1.35
    }
    if (game.scrapeTimer <= 0) {
      game.scrapeTimer = 0.9
      emitSpace(game, 'scrape', 'HULL SCRAPE', 0, shipPoint(game))
    }
  }
}

/** Docking Assist gently rolls the ship onto the hatch inside its range. */
function autoAlignToDock(game: Game, dt: number) {
  if (!hasUpgrade(game, 'dockingassist') || canDock(game)) return
  const ship = game.ship
  const dx = game.dockPos.x - ship.x
  const dy = game.dockPos.y - ship.y
  const dz = game.dockPos.z - ship.z
  const distance = Math.hypot(dx, dy, dz)
  if (distance > DOCK_ASSIST_RANGE || distance < 1e-4) return
  const desired = quatFromBasis(
    { x: dx / distance, y: dy / distance, z: dz / distance },
    { x: 0, y: 1, z: 0 },
  )
  ship.q = quatNlerp(ship.q, desired, Math.min(1, DOCK_ASSIST_TURN * dt * 0.35), ship.q)
}

function updateShip(game: Game, dt: number, input: Input) {
  const ship = game.ship
  const pitch = clamp(input.pitch, -1, 1)
  const yaw = clamp(input.yaw, -1, 1)
  const roll = clamp(input.roll, -1, 1)

  // local-frame angular velocity: +pitch input pitches the nose up, +roll rolls right
  quatIntegrate(ship.q, {
    x: -pitch * SHIP_PITCH_RATE,
    y: yaw * SHIP_YAW_RATE,
    z: -roll * SHIP_ROLL_RATE,
  }, dt)

  // arcade auto-bank back toward level flight when the player is not rolling
  if (Math.abs(roll) < 0.2) {
    const bank = quatToFlightAngles(ship.q).roll
    if (Math.abs(bank) > 1e-4) {
      quatIntegrate(ship.q, { x: 0, y: 0, z: bank * SHIP_LEVEL_K }, dt)
    }
  }

  const forward = quatForward(ship.q, SCRATCH_FORWARD)
  const thrust = clamp(input.y, -1, 1)
  const boosting = input.boost || input.hop
  ship.thrust = thrust
  ship.boosting = boosting && thrust > 0.12
  let targetSpeed = 0
  if (thrust > 0.12) targetSpeed = (boosting ? boostSpeed(game) : shipSpeed(game)) * thrust
  else if (thrust < -0.12) targetSpeed = SHIP_REVERSE_SPEED * thrust

  const k = 1 - Math.exp(-SHIP_ACCEL_K * dt)
  const previousVx = ship.vx
  const previousVy = ship.vy
  const previousVz = ship.vz
  ship.vx += (forward.x * targetSpeed - ship.vx) * k
  ship.vy += (forward.y * targetSpeed - ship.vy) * k
  ship.vz += (forward.z * targetSpeed - ship.vz) * k
  // trapezoidal integration of the damped velocity: matches the analytic
  // solution to O(dt^2), so 60/120/144 Hz produce the same flight path
  ship.x += (previousVx + ship.vx) * 0.5 * dt
  ship.y += (previousVy + ship.vy) * 0.5 * dt
  ship.z += (previousVz + ship.vz) * 0.5 * dt
  ship.speed = Math.hypot(ship.vx, ship.vy, ship.vz)
  collideBodies(game)
  autoAlignToDock(game, dt)
}

// --------------------------------------------------------------------- step

export function step(game: Game, elapsed: number, input: Input) {
  if (game.phase !== 'playing') return
  const dt = clamp(elapsed, 0, 0.1)
  game.time += dt
  game.scrapeTimer = Math.max(0, game.scrapeTimer - dt)
  updateBodies(game, dt)

  if (game.mode === 'docked') {
    snapShipToDock(game)
    return
  }
  if (game.transition) {
    const transition = game.transition
    transition.t += dt
    if (transition.t >= transition.duration) finishTransition(game)
    return
  }
  if (game.mode === 'surface') {
    updateSurface(game, dt, input)
    if (game.phase === 'playing') updateHazards(game, dt)
  } else {
    updateShip(game, dt, input)
  }
}

export type { PlayMode }
