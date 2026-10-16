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
  SPRINT_MULTIPLIER, SPACE_SCALE, STORM_DRAIN_MULT, STORM_DURATION, STORM_PERIOD, STORM_PUSH, STORM_WARN_LEAD,
  STORM_WARN_LEAD_BONUS, STRIDE_BONUS, SUFFOCATION_DAMAGE, SUN_RADIUS, SURFACE_RADIUS, TAU,
  THRUSTER_BONUS, TRANSITION_TIME, WALK_SPEED, WIDE_SCOOP_BONUS,
  SHIP_STRAFE_SPEED, SURFACE_TURN_RATE, SURFACE_PITCH_RATE, BODY_BOUNCE, BODY_REST_SPEED,
  GRAVITY_SOI, GRAVITY_SOI_FADE, PLANET_MU, SHIP_WELL_ACCEL, SHIP_WELL_SOFT,
  ORBIT_TRIM_BAND_MIN, ORBIT_TRIM_BAND_MAX, ORBIT_TRIM_RATE, ORBIT_HOLD_RANGE, DEEP_SPACE_ASSIST_FADE,
  SUN_BODY, SUN_MU, SUN_COOL_RATE, SUN_DAMAGE_HEAT, SUN_DAMAGE_PER_SEC, SUN_BURN_RADIUS,
  SUN_HEAT_RADIUS, SUN_HEAT_RATE, SUN_WARN_HEAT, GRAVITY_SOI_SUN, GRAVITY_SOI_FADE_SUN,
} from './config.ts'
import { RELIC_BY_PLANET, SHOP_BY_ID } from './economy.ts'
import { quatForward, quatFromBasis, quatIntegrate, quatNlerp, quatRight, quatToFlightAngles } from './orient.ts'
import { PLANETS, landerSite, planetById, surfaceRadiusOf } from './planets.ts'
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

/**
 * Maps the pointer frame to sim-world movement: screen +x = right, +y = up,
 * aim 0 = straight up the screen. The rendered world is mirror-handed, so
 * screen-right is -east. Used by input.ts and covered by tests.
 */
export function screenMoveVector(aim: number, screenX: number, screenY: number): { x: number; y: number } {
  const length = Math.min(1, Math.hypot(screenX, screenY))
  if (length < 0.06) return { x: 0, y: 0 }
  const beta = aim + Math.atan2(screenX, screenY)
  return { x: -Math.sin(beta) * length, y: Math.cos(beta) * length }
}

/**
 * Great-circle distance between two surface points, in metres. The radius is
 * the world's own, because Earth's landing site is a valley half a kilometre
 * across and the Moon's is a crater field - one number cannot serve both.
 */
export function latLonDistance(
  a: { lat: number; lon: number }, b: { lat: number; lon: number }, planetId = 0,
): number {
  const dLat = a.lat - b.lat
  const dLon = wrapAngle(a.lon - b.lon)
  const x = dLon * Math.cos((a.lat + b.lat) / 2)
  return Math.hypot(x, dLat) * surfaceRadiusOf(planetId)
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
  planetById(game.planetId).breathable
    ? 0
    : OXYGEN_DRAIN
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
    const distance = latLonDistance(game.player, item, game.planetId)
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
    heatWarned: false,
    heatCriticalWarned: false,
    atLander: true,
    scrapeTimer: 0,
    planetId: options.planetId ?? 0,
    player: { lat: 0, lon: 0, h: 0, vH: 0, vN: 0, vE: 0, facing: 0, lookPitch: 0, hopCooldown: 0 },
    ship: {
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      q: { ...IDENTITY_Q }, speed: 0, thrust: 0, boosting: false, heat: 0,
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
      if (latLonDistance(item, lander, planet.id) < minimum) {
        const nudge = (relic ? 0.34 : 0.28) * (SURFACE_RADIUS / planet.surfaceRadius)
        lat = clamp(lat + nudge, -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05)
        item.lat = lat
        if (latLonDistance(item, lander, planet.id) < minimum) {
          item.lon = wrapAngle(item.lon + nudge)
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

/** Velocity of a body riding a scripted circular orbit (d/dt of `orbitPoint`). */
function orbitVelocity(radius: number, rate: number, angle: number, target: Vec3): Vec3 {
  const speed = radius * rate
  target.x = -Math.sin(angle) * speed
  target.y = 0
  target.z = Math.cos(angle) * speed
  return target
}

const ORBIT_VEL_B: Vec3 = { x: 0, y: 0, z: 0 }
const ORBIT_ACCEL_B: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * A world's own acceleration in the map frame - toward the Sun for Earth and Mars,
 * toward Earth for the Moon (16.8 u/s^2, four times the Moon's own surface
 * gravity). Flying in a world's frame means riding its motion, so this is part of
 * the coordinate conversion, not a force on the ship: `updateShip` predicts the
 * world's next velocity with it.
 *
 * It has to be the rate of change of the WHOLE of `planetVelocity`, though, and
 * for the Moon that includes Earth's orbit as well as the Moon's own. Charging
 * only the Moon's own term left Earth's acceleration about the Sun (0.63 u/s^2)
 * uncompensated, and because the conversion runs every step it landed in the
 * ship's velocity *relative to the Moon* as a constant extra pull. Earth and Mars
 * never showed it because their `planetVelocity` is nothing but the orbit this
 * already covers.
 */
function frameAcceleration(game: Game, body: number, target: Vec3): Vec3 {
  target.x = 0
  target.y = 0
  target.z = 0
  if (body === SUN_BODY) return target
  const planet = PLANETS[body]
  const centre = game.planetPos[body]
  const parentX = body === 1 ? game.planetPos[0].x : 0
  const parentY = body === 1 ? game.planetPos[0].y : 0
  const parentZ = body === 1 ? game.planetPos[0].z : 0
  const dx = parentX - centre.x
  const dy = parentY - centre.y
  const dz = parentZ - centre.z
  const distance = Math.hypot(dx, dy, dz) || 1
  const strength = planet.orbitRate * planet.orbitRate * planet.orbit
  target.x = (dx / distance) * strength
  target.y = (dy / distance) * strength
  target.z = (dz / distance) * strength
  // riding the parent's orbit too, so the frame carries the parent's acceleration
  if (body === 1) {
    const parent = frameAcceleration(game, 0, ORBIT_ACCEL_B)
    target.x += parent.x
    target.y += parent.y
    target.z += parent.z
  }
  return target
}

/** The world's own velocity in the map frame - the Moon rides Earth's orbit too. */
function planetVelocity(game: Game, body: number, target: Vec3): Vec3 {
  target.x = 0
  target.y = 0
  target.z = 0
  // the Sun is the one body that never moves, so its frame is the map's
  if (body === SUN_BODY) return target
  const planet = PLANETS[body]
  const angle = body === 0 ? game.earthAngle : body === 1 ? game.moonAngle : game.marsAngle
  orbitVelocity(planet.orbit, planet.orbitRate, angle, target)
  if (body === 1) {
    planetVelocity(game, 0, ORBIT_VEL_B)
    target.x += ORBIT_VEL_B.x
    target.y += ORBIT_VEL_B.y
    target.z += ORBIT_VEL_B.z
  }
  return target
}

/** A world's pull on the ship, as felt this frame. */
interface Well {
  x: number
  y: number
  z: number
  body: number
  /** the world's gravitational parameter - the pull at any radius is mu / r^2 */
  mu: number
  /** distance from the world's centre */
  radius: number
  /** 1 deep inside the sphere of influence, easing to 0 at its edge */
  weight: number
  /** circular-orbit speed at this radius, relative to the world */
  circular: number
}

const SCRATCH_WELL: Well = { x: 0, y: 0, z: 0, body: -1, mu: 0, radius: 0, weight: 0, circular: 0 }
const SCRATCH_VEL: Vec3 = { x: 0, y: 0, z: 0 }
const SCRATCH_RELATIVE: Vec3 = { x: 0, y: 0, z: 0 }
const SCRATCH_ACCEL: Vec3 = { x: 0, y: 0, z: 0 }
const SCRATCH_TARGET_VEL: Vec3 = { x: 0, y: 0, z: 0 }

/** The point a well is centred on. The Sun sits at the origin and never moves. */
const SUN_CENTRE: Vec3 = { x: 0, y: 0, z: 0 }
function wellCentre(game: Game, body: number): Vec3 {
  return body === SUN_BODY ? SUN_CENTRE : game.planetPos[body]
}

/**
 * The well holding the ship, or null in deep space. The smallest sphere of
 * influence containing it wins, so the Moon takes over from Earth near the
 * Moon, and every world keeps a clean pull of its own in a map this compressed.
 * The Sun is the floor underneath all of them: its sphere is the widest, so it
 * only applies where nothing else does, and it is what the whole map falls into.
 */
function sampleGravity(game: Game, x: number, y: number, z: number): Well | null {
  let body = -1
  for (const planet of PLANETS) {
    if (body >= 0 && GRAVITY_SOI[planet.id] >= GRAVITY_SOI[body]) continue
    const position = game.planetPos[planet.id]
    if (Math.hypot(x - position.x, y - position.y, z - position.z) >= GRAVITY_SOI[planet.id]) continue
    body = planet.id
  }
  if (body < 0) {
    const distance = Math.hypot(x, y, z)
    if (distance >= GRAVITY_SOI_SUN || distance < 1e-6) return null
    const inner = GRAVITY_SOI_SUN * (1 - GRAVITY_SOI_FADE_SUN)
    let weight = 1
    if (distance > inner) {
      const t = (GRAVITY_SOI_SUN - distance) / (GRAVITY_SOI_SUN - inner)
      weight = t * t * (3 - 2 * t)
    }
    const strength = (SUN_MU / (distance * distance)) * weight
    const well = SCRATCH_WELL
    well.x = (-x / distance) * strength
    well.y = (-y / distance) * strength
    well.z = (-z / distance) * strength
    well.mu = SUN_MU
    well.body = SUN_BODY
    well.radius = distance
    well.weight = weight
    well.circular = Math.sqrt(SUN_MU / distance)
    return well
  }
  const position = game.planetPos[body]
  const soi = GRAVITY_SOI[body]
  const dx = position.x - x
  const dy = position.y - y
  const dz = position.z - z
  const radius = Math.hypot(dx, dy, dz)
  if (radius < 1e-6) return null
  const inner = soi * (1 - GRAVITY_SOI_FADE)
  let weight = 1
  if (radius > inner) {
    const t = (soi - radius) / (soi - inner)
    weight = t * t * (3 - 2 * t)
  }
  const mu = PLANET_MU[body]
  const strength = (mu / (radius * radius)) * weight
  const well = SCRATCH_WELL
  well.x = (dx / radius) * strength
  well.y = (dy / radius) * strength
  well.z = (dz / radius) * strength
  well.mu = mu
  well.body = body
  well.radius = radius
  well.weight = weight
  well.circular = Math.sqrt(mu / radius)
  return well
}

/** The station's own velocity relative to Earth, from its scripted orbit. */
function dockVelocity(game: Game, target: Vec3): Vec3 {
  return orbitVelocity(ISS_ORBIT + ISS_DOCK_OFFSET, ISS_ORBIT_RATE, game.issAngle, target)
}

/** How far outside every sphere of influence the ship is, in world units. */
function distanceBeyondWells(game: Game, ship: Game['ship']): number {
  let closest = Infinity
  for (const planet of PLANETS) {
    const position = game.planetPos[planet.id]
    const gap = Math.hypot(ship.x - position.x, ship.y - position.y, ship.z - position.z) - GRAVITY_SOI[planet.id]
    if (gap < closest) closest = gap
  }
  return closest
}

/**
 * The tug's own autopilot, and the only invisible hand in the sky: idle inside a
 * world's pull it trims the ship into that world's orbit - the speed the ISS keeps
 * - so letting go of the booster near the station leaves you circling with it.
 * Outside the band (a fast flyby) or diving straight at a world (a landing
 * approach) it keeps out of the way and gravity is left to do whatever it does.
 */
function orbitTrim(game: Game, relative: Vec3, x: number, y: number, z: number, well: Well, dt: number) {
  // the autopilot parks you in orbit around worlds, not around stars: trimming
  // into a circle a thousand units off the Sun would quietly undo the hazard
  if (well.body === SUN_BODY) return
  if (well.weight < 1) return
  const radius = Math.hypot(x, y, z)
  if (radius < 1e-6) return
  const circular = Math.sqrt(well.mu / radius)
  // at the hatch, match the station rather than the sky: that is free fall with it
  const atHatch = distance3(game.ship, game.dockPos) <= ORBIT_HOLD_RANGE
  const relativeSpeed = Math.hypot(relative.x, relative.y, relative.z)
  if (!atHatch) {
    if (relativeSpeed < circular * ORBIT_TRIM_BAND_MIN) return
    if (relativeSpeed > circular * ORBIT_TRIM_BAND_MAX) return
  }
  const nx = x / radius
  const ny = y / radius
  const nz = z / radius
  const radial = relative.x * nx + relative.y * ny + relative.z * nz
  // a straight dive stays a dive - the trim only steadies what already circles
  if (!atHatch && Math.abs(radial) > 0.75 * relativeSpeed) return
  let tx = relative.x - radial * nx
  let ty = relative.y - radial * ny
  let tz = relative.z - radial * nz
  const tangent = Math.hypot(tx, ty, tz)
  if (tangent < 1e-4) return
  tx /= tangent
  ty /= tangent
  tz /= tangent
  let targetX: number
  let targetY: number
  let targetZ: number
  if (atHatch) {
    const station = dockVelocity(game, SCRATCH_TARGET_VEL)
    targetX = station.x
    targetY = station.y
    targetZ = station.z
  } else {
    targetX = tx * circular
    targetY = ty * circular
    targetZ = tz * circular
  }
  const blend = 1 - Math.exp(-ORBIT_TRIM_RATE * dt)
  relative.x += (targetX - relative.x) * blend
  relative.y += (targetY - relative.y) * blend
  relative.z += (targetZ - relative.z) * blend
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
  player.lookPitch = 0
  game.atLander = true
}

const SCRATCH_UP: Vec3 = { x: 0, y: 0, z: 0 }
const SCRATCH_TANGENT: Vec3 = { x: 0, y: 0, z: 0 }

/** Park the tug on the pad, nose pointed along the planet's orbital motion. */
export function placeShipOnPad(game: Game) {
  const planet = planetById(game.planetId)
  const centre = game.planetPos[game.planetId]
  const site = landerSite(game.planetId)
  const pad = surfaceToWorld(centre, site.lat, site.lon, planet.spaceRadius + 12 * SPACE_SCALE)
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
  latLonDistance(game.player, landerSite(game.planetId), game.planetId) <= LANDER_RING_RADIUS

export function canDock(game: Game): boolean {
  return game.mode === 'space' && !game.transition && distance3(game.ship, game.dockPos) <= dockRadius(game)
}

/** The landable planet the ship is inside the landing zone of, or -1. */
export function landingZone(game: Game): number {
  if (game.mode !== 'space' || game.transition) return -1
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

/** The planet the ship can land on right now (inside the zone and slow enough). */
export function landTarget(game: Game): number {
  const zone = landingZone(game)
  if (zone < 0 || game.ship.speed > LAND_MAX_SPEED) return -1
  return zone
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
    if (landingZone(game) >= 0) return 'SLOW DOWN TO LAND'
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
  // a release is a release from a moving platform: the tug leaves with the
  // station's own orbit, plus a nudge out of the hatch
  const station = dockVelocity(game, SCRATCH_TARGET_VEL)
  const drift = planetVelocity(game, 0, SCRATCH_VEL)
  game.ship.vx = drift.x + station.x + (dx / length) * 8
  game.ship.vy = drift.y + station.y
  game.ship.vz = drift.z + station.z + (dz / length) * 8
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

/**
 * The tug is gone.
 *
 * There is no beacon for this one, and that is the point: the beacon calls a
 * rescue to a suit that has failed, and here it is the ship that has failed. The
 * run ends where it started and the next one begins from the beginning.
 */
function burnUp(game: Game) {
  game.health = 0
  game.ship.heat = 1
  game.phase = 'finished'
  game.outcome = 'lost'
  emitSpace(game, 'lose', 'HULL BURNED THROUGH', 0, shipPoint(game))
}

/**
 * The Sun's corona, and what it does to a hull.
 *
 * Heat is not a timer, it is a distance: it goes in at a rate that rises as the
 * square of how far inside the warning ring the ship is, and the sky takes it
 * back out at a flat rate whenever the ship is out. That is the whole decision
 * the hazard asks you to make - turning round early always works and turning
 * round late sometimes does not - and it is why the warning has to arrive while
 * there is still somewhere to turn round to.
 *
 * Past the damage threshold the hull fails progressively, and the failure feeds
 * itself: the hotter it gets the faster it goes, so the last second is the
 * expensive one.
 */
function updateSunHeat(game: Game, dt: number) {
  const ship = game.ship
  const distance = Math.hypot(ship.x, ship.y, ship.z)
  const closeness = clamp((SUN_HEAT_RADIUS - distance) / (SUN_HEAT_RADIUS - SUN_BURN_RADIUS), 0, 1)
  if (closeness > 0) {
    ship.heat = Math.min(1, ship.heat + closeness * closeness * SUN_HEAT_RATE * dt)
  } else {
    ship.heat = Math.max(0, ship.heat - SUN_COOL_RATE * dt)
  }

  if (ship.heat >= SUN_DAMAGE_HEAT && !game.heatCriticalWarned) {
    game.heatWarned = true
    game.heatCriticalWarned = true
    emitSpace(game, 'heat', 'HULL BURNING - PULL AWAY NOW', 0, shipPoint(game))
  } else if (ship.heat >= SUN_WARN_HEAT && !game.heatWarned) {
    game.heatWarned = true
    emitSpace(game, 'heat', 'HULL TEMPERATURE RISING - TURN BACK', 0, shipPoint(game))
  }
  // the warnings re-arm once the hull is comfortably cool, so a second approach
  // is warned about as loudly as the first
  if (ship.heat < SUN_WARN_HEAT * 0.5) {
    game.heatWarned = false
    game.heatCriticalWarned = false
  }

  if (ship.heat <= SUN_DAMAGE_HEAT) return
  const runaway = (ship.heat - SUN_DAMAGE_HEAT) / (1 - SUN_DAMAGE_HEAT)
  game.health = Math.max(0, game.health - SUN_DAMAGE_PER_SEC * runaway * dt)
  if (game.health <= 0) burnUp(game)
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
  // berthed to the station means travelling with it, not stopped in the map frame
  const station = dockVelocity(game, SCRATCH_TARGET_VEL)
  const drift = planetVelocity(game, 0, SCRATCH_VEL)
  ship.vx = drift.x + station.x
  ship.vy = drift.y + station.y
  ship.vz = drift.z + station.z
  ship.speed = Math.hypot(ship.vx, ship.vy, ship.vz)
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
    const ground = latLonDistance(game.player, item, game.planetId)
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
  const surfaceR = planet.surfaceRadius
  const player = game.player
  const length = Math.hypot(input.x, input.y)
  const speed = walkSpeed(game, input.boost)
  const onGround = player.h <= 0 && player.vH <= 0

  if (length > 0.12) {
    const nx = input.x / Math.max(1, length)
    const ny = input.y / Math.max(1, length)
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

  // the pointer steers him: full lock turns at SURFACE_TURN_RATE and the
  // chase camera swings around behind whatever he is facing
  const turn = clamp(input.turn ?? 0, -1, 1)
  if (turn !== 0) player.facing = wrapAngle(player.facing + turn * SURFACE_TURN_RATE * dt)
  // and where the pointer sits on the screen tips the camera over his shoulder,
  // smoothed rather than set so a cursor crossing the middle does not snap the
  // horizon about
  player.lookPitch += (clamp(input.pitch ?? 0, -1, 1) - player.lookPitch) * Math.min(1, SURFACE_PITCH_RATE * dt)

  player.lat = clamp(player.lat + (player.vN * dt) / surfaceR, -POLE_CLAMP, POLE_CLAMP)
  const cosLat = Math.max(0.3, Math.cos(player.lat))
  player.lon = wrapAngle(player.lon + (player.vE * dt) / (surfaceR * cosLat))

  // storm wind shoves the janitor sideways while a dust storm blows
  if (game.hazards.stormActive && game.hazards.stormIntensity > 0.05) {
    const push = STORM_PUSH * game.hazards.stormIntensity * game.hazards.stormWind * dt
    player.lon = wrapAngle(player.lon + push / (surfaceR * cosLat))
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
        const distance = latLonDistance(game.player, { lat: hazards.meteorLat, lon: hazards.meteorLon }, game.planetId)
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
        const surfaceR = surfaceRadiusOf(game.planetId)
        hazards.meteorLat = clamp(
          game.player.lat + randomBetween(game, -1, 1) * (METEOR_RANGE / surfaceR),
          -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05,
        )
        hazards.meteorLon = wrapAngle(
          game.player.lon + randomBetween(game, -1, 1) * (METEOR_RANGE / (surfaceR * cosLat)),
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
const SCRATCH_RIGHT: Vec3 = { x: 0, y: 0, z: 0 }

function collideBodies(game: Game) {
  const ship = game.ship
  // the shell belongs to a world that is itself racing along its orbit, so only the
  // ship's motion relative to that world belongs in the bounce - reflecting the map
  // velocity instead hands the tug the planet's own speed
  const bodies: { x: number; y: number; z: number; radius: number; rx: number; ry: number; rz: number }[] = [
    { x: 0, y: 0, z: 0, radius: SUN_RADIUS + BODY_CLEARANCE * 2, rx: 0, ry: 0, rz: 0 },
  ]
  for (const planet of PLANETS) {
    const position = game.planetPos[planet.id]
    const drift = planetVelocity(game, planet.id, SCRATCH_VEL)
    bodies.push({
      x: position.x,
      y: position.y,
      z: position.z,
      radius: planet.spaceRadius + BODY_CLEARANCE,
      rx: drift.x,
      ry: drift.y,
      rz: drift.z,
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
    const relativeX = ship.vx - body.rx
    const relativeY = ship.vy - body.ry
    const relativeZ = ship.vz - body.rz
    const normalVelocity = relativeX * nx + relativeY * ny + relativeZ * nz
    if (normalVelocity < 0) {
      // gravity keeps pressing a landed ship into the shell, so a gentle contact
      // is simply stopped - only a real impact bounces
      const bounce = normalVelocity < -BODY_REST_SPEED ? BODY_BOUNCE : 1
      ship.vx -= nx * normalVelocity * bounce
      ship.vy -= ny * normalVelocity * bounce
      ship.vz -= nz * normalVelocity * bounce
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

  // Local-frame angular velocity. Screen convention: the chase camera looks
  // along the nose, so +yaw input turns the nose right on screen, +pitch input
  // lifts it, +roll input banks the ship right (right side dips).
  quatIntegrate(ship.q, {
    x: -pitch * SHIP_PITCH_RATE,
    y: -yaw * SHIP_YAW_RATE,
    z: roll * SHIP_ROLL_RATE,
  }, dt)

  // arcade auto-bank back toward level flight when the player is not rolling
  if (Math.abs(roll) < 0.2) {
    const bank = quatToFlightAngles(ship.q).roll
    if (Math.abs(bank) > 1e-4) {
      quatIntegrate(ship.q, { x: 0, y: 0, z: -bank * SHIP_LEVEL_K }, dt)
    }
  }

  const forward = quatForward(ship.q, SCRATCH_FORWARD)
  const thrust = clamp(input.y, -1, 1)
  // lateral strafe: screen-right is the ship's -X axis (same mirror as the surface)
  const strafeInput = clamp(input.x, -1, 1)
  const side = quatRight(ship.q, SCRATCH_RIGHT)
  const boosting = input.boost || input.hop
  ship.thrust = thrust
  ship.boosting = boosting && thrust > 0.12

  const previousVx = ship.vx
  const previousVy = ship.vy
  const previousVz = ship.vz
  const well = sampleGravity(game, ship.x, ship.y, ship.z)
  const idle = Math.abs(thrust) <= 0.12 && Math.abs(strafeInput) <= 0.12

  if (well) {
    // Inside a world's pull the tug flies in that world's own frame: the world's
    // gravity is the only force, thrust is a real acceleration, letting go is
    // coasting, and the ship rides along with the world. Nothing is drawn for the
    // field - you read it in the course of the ship.
    const centre = wellCentre(game, well.body)
    const drift = planetVelocity(game, well.body, SCRATCH_VEL)
    const relative: Vec3 = SCRATCH_RELATIVE
    relative.x = ship.vx - drift.x
    relative.y = ship.vy - drift.y
    relative.z = ship.vz - drift.z
    let ax = well.x
    let ay = well.y
    let az = well.z
    if (Math.abs(thrust) > 0.12) {
      const along = relative.x * forward.x + relative.y * forward.y + relative.z * forward.z
      const cap = thrust > 0 ? (boosting ? boostSpeed(game) : shipSpeed(game)) * thrust : SHIP_REVERSE_SPEED * -thrust
      const ease = clamp((cap - (thrust > 0 ? along : -along)) / (cap * SHIP_WELL_SOFT), 0, 1)
      ax += forward.x * SHIP_WELL_ACCEL * thrust * ease
      ay += forward.y * SHIP_WELL_ACCEL * thrust * ease
      az += forward.z * SHIP_WELL_ACCEL * thrust * ease
    }
    if (Math.abs(strafeInput) > 0.12) {
      const rightward = -(relative.x * side.x + relative.y * side.y + relative.z * side.z) * Math.sign(strafeInput)
      const ease = clamp((SHIP_STRAFE_SPEED - rightward) / (SHIP_STRAFE_SPEED * SHIP_WELL_SOFT), 0, 1)
      ax -= side.x * SHIP_WELL_ACCEL * Math.sign(strafeInput) * ease
      ay -= side.y * SHIP_WELL_ACCEL * Math.sign(strafeInput) * ease
      az -= side.z * SHIP_WELL_ACCEL * Math.sign(strafeInput) * ease
    }
    // Velocity-Verlet (kick, drift, kick): a symplectic step, so an orbit keeps its
    // energy. An average-velocity step has run-away energy here - it pumps the orbit
    // outward, which the old damper used to hide.
    const halfVx = relative.x + ax * 0.5 * dt
    const halfVy = relative.y + ay * 0.5 * dt
    const halfVz = relative.z + az * 0.5 * dt
    const nextX = (ship.x - centre.x) + halfVx * dt
    const nextY = (ship.y - centre.y) + halfVy * dt
    const nextZ = (ship.z - centre.z) + halfVz * dt
    const pull = -(well.mu * well.weight) / ((nextX * nextX + nextY * nextY + nextZ * nextZ || 1) ** 1.5) * 0.5 * dt
    relative.x = halfVx + nextX * pull
    relative.y = halfVy + nextY * pull
    relative.z = halfVz + nextZ * pull
    if (idle) orbitTrim(game, relative, nextX, nextY, nextZ, well, dt)
    // back to map coordinates riding the world's own motion: its scripted drift and
    // drift-rate carry the ship along
    const accel = frameAcceleration(game, well.body, SCRATCH_ACCEL)
    ship.x = centre.x + (drift.x + accel.x * dt * 0.5) * dt + nextX
    ship.y = centre.y + (drift.y + accel.y * dt * 0.5) * dt + nextY
    ship.z = centre.z + (drift.z + accel.z * dt * 0.5) * dt + nextZ
    ship.vx = drift.x + accel.x * dt + relative.x
    ship.vy = drift.y + accel.y * dt + relative.y
    ship.vz = drift.z + accel.z * dt + relative.z
  } else {
    // Deep space keeps the tug's old fly-by-wire handling: it tracks the commanded
    // velocity and parks itself when the keys are released. The gain fades in just
    // outside a sphere of influence, so leaving a well is a drift, not a slam.
    let targetSpeed = 0
    if (thrust > 0.12) targetSpeed = (boosting ? boostSpeed(game) : shipSpeed(game)) * thrust
    else if (thrust < -0.12) targetSpeed = SHIP_REVERSE_SPEED * thrust
    const strafe = strafeInput * SHIP_STRAFE_SPEED
    const k = (1 - Math.exp(-SHIP_ACCEL_K * dt)) * clamp(distanceBeyondWells(game, ship) / DEEP_SPACE_ASSIST_FADE, 0, 1)
    ship.vx += (forward.x * targetSpeed - side.x * strafe - ship.vx) * k
    ship.vy += (forward.y * targetSpeed - side.y * strafe - ship.vy) * k
    ship.vz += (forward.z * targetSpeed - side.z * strafe - ship.vz) * k
    // trapezoidal integration: matches the analytic solution to O(dt^2), so
    // 60/120/144 Hz produce the same flight path
    ship.x += (previousVx + ship.vx) * 0.5 * dt
    ship.y += (previousVy + ship.vy) * 0.5 * dt
    ship.z += (previousVz + ship.vz) * 0.5 * dt
  }
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
    if (game.phase === 'playing') updateSunHeat(game, dt)
  }
}

export type { PlayMode }
