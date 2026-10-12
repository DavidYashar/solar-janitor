import {
  AIR_CONTROL_K, BATCH_BONUS, BATCH_BONUS_SIZE, BODY_CLEARANCE, CARRY_SLOTS, CLEAN_BONUS,
  DOCK_RADIUS, EARTH_RADIUS, FULL_HOLD_BONUS, GRAVITY_BASE, HARD_LAND_DAMAGE, HARD_LAND_SPEED,
  HEALTH_MAX, HOLD_SLOTS, HOP_COOLDOWN, HOP_SPEED, ISS_DOCK_OFFSET, ISS_ORBIT, ISS_ORBIT_RATE,
  JUNK_POINTS, LANDER_RING_RADIUS, LAND_MAX_SPEED, LAND_ZONE_HEIGHT, MOON_ORBIT, MOON_ORBIT_RATE,
  MOON_RADIUS, OXYGEN_DRAIN, OXYGEN_MAX, OXYGEN_REFILL, OXYGEN_WARN, POLE_CLAMP, SCOOP_RADIUS,
  SHIP_ACCEL_K, SHIP_BOOST_SPEED, SHIP_REVERSE_SPEED, SHIP_SPEED, SHIP_YAW_RATE, SPRINT_MULTIPLIER,
  SUFFOCATION_DAMAGE, SUN_RADIUS, SURFACE_RADIUS, TAU, TRANSITION_TIME, WALK_SPEED,
} from './config.ts'
import { SHOP_BY_ID } from './economy.ts'
import { landerSite, planetById } from './planets.ts'
import { nextRandom, randomBetween } from './rng.ts'
import type { EventKind, Game, Input, Junk, JunkClass, Vec3 } from './types.ts'

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

export function hasUpgrade(game: Game, id: string): boolean {
  return game.upgrades.includes(id)
}

export const maxOxygen = (game: Game) => OXYGEN_MAX + (hasUpgrade(game, 'o2tank') ? 30 : 0)
export const carrySlots = (game: Game) => CARRY_SLOTS + (hasUpgrade(game, 'cargogloves') ? 3 : 0)
export const holdSlots = (game: Game) => HOLD_SLOTS + (hasUpgrade(game, 'cargoracks') ? 24 : 0)
export const scoopRadius = (game: Game) => SCOOP_RADIUS + (hasUpgrade(game, 'widescoop') ? 1.6 : 0)
export const shipSpeed = (game: Game) => SHIP_SPEED * (hasUpgrade(game, 'thrusterkit') ? 1.25 : 1)
export const boostSpeed = (game: Game) => SHIP_BOOST_SPEED * (hasUpgrade(game, 'thrusterkit') ? 1.25 : 1)

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

export function progressSummary(game: Game) {
  return {
    delivered: deliveredCount(game),
    total: planetJunkTotal(game),
    hold: holdCount(game),
    holdCap: holdSlots(game),
    carry: carryCount(game),
    carryCap: carrySlots(game),
  }
}

export function rank(game: Game): string {
  const score = game.score
  if (score >= 3100) return 'LEGEND'
  if (score >= 2700) return 'PLATINUM'
  if (score >= 2000) return 'GOLD'
  if (score >= 1200) return 'SILVER'
  return 'BRONZE'
}

// ------------------------------------------------------------------- events

function emitSurface(
  game: Game, kind: EventKind, text: string, amount: number, at: { lat: number; lon: number; h: number },
) {
  game.events.push({
    kind, text, amount, place: 'surface', lat: at.lat, lon: at.lon, h: at.h, x: 0, y: 0, z: 0,
  })
}

function emitSpace(game: Game, kind: EventKind, text: string, amount: number, at: Vec3) {
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
    ship: { x: 0, y: 0, z: 0, vx: 0, vz: 0, yaw: 0, speed: 0, thrust: 0, boosting: false },
    earthAngle: 0,
    issAngle: 0,
    moonAngle: 0,
    earthPos: { x: 0, y: 0, z: 0 },
    issPos: { x: 0, y: 0, z: 0 },
    dockPos: { x: 0, y: 0, z: 0 },
    moonPos: { x: 0, y: 0, z: 0 },
    junk: [],
    upgrades: [],
    delivered: 0,
    bestBatch: 0,
    trips: 0,
    rescued: false,
    events: [],
    nextId: 0,
  }
  game.earthAngle = randomBetween(game, 0, TAU)
  game.issAngle = randomBetween(game, 0, TAU)
  game.moonAngle = randomBetween(game, 0, TAU)
  buildJunk(game)
  computeBodies(game)
  placePlayerAtLander(game)
  placeShipOnPad(game)
  return game
}

function buildJunk(game: Game) {
  const planet = planetById(game.planetId)
  const lander = landerSite(game.planetId)
  for (let i = 0; i < planet.junkCount; i++) {
    const roll = nextRandom(game)
    const cls: JunkClass = roll < 0.58 ? 'scrap' : roll < 0.86 ? 'tech' : 'hazardous'
    // roughly a third of the pieces scatter further out, the rest cluster near the lander
    const spread = nextRandom(game) < 0.34 ? 1 : 0.45
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
    // never drop junk onto the lander pad itself
    if (latLonDistance(item, lander) < LANDER_RING_RADIUS + 3) {
      lat = clamp(lat + 0.28, -POLE_CLAMP + 0.05, POLE_CLAMP - 0.05)
      item.lat = lat
    }
    game.junk.push(item)
  }
}

export function computeBodies(game: Game) {
  const planet = planetById(game.planetId)
  const ea = game.earthAngle
  game.earthPos.x = planet.orbit * Math.cos(ea)
  game.earthPos.y = 0
  game.earthPos.z = planet.orbit * Math.sin(ea)

  game.issPos.x = game.earthPos.x + ISS_ORBIT * Math.cos(game.issAngle)
  game.issPos.y = 0
  game.issPos.z = game.earthPos.z + ISS_ORBIT * Math.sin(game.issAngle)

  game.dockPos.x = game.earthPos.x + (ISS_ORBIT + ISS_DOCK_OFFSET) * Math.cos(game.issAngle)
  game.dockPos.y = 0
  game.dockPos.z = game.earthPos.z + (ISS_ORBIT + ISS_DOCK_OFFSET) * Math.sin(game.issAngle)

  game.moonPos.x = game.earthPos.x + MOON_ORBIT * Math.cos(game.moonAngle)
  game.moonPos.y = 0
  game.moonPos.z = game.earthPos.z + MOON_ORBIT * Math.sin(game.moonAngle)
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

export function placeShipOnPad(game: Game) {
  const site = landerSite(game.planetId)
  const pad = surfaceToWorld(game.earthPos, site.lat, site.lon, EARTH_RADIUS + 9)
  const ship = game.ship
  ship.x = pad.x
  ship.y = pad.y
  ship.z = pad.z
  ship.vx = 0
  ship.vz = 0
  ship.speed = 0
  // face prograde along the planet's orbit
  ship.yaw = wrapAngle(-game.earthAngle)
}

// ------------------------------------------------------------------ queries

export const nearLander = (game: Game): boolean =>
  latLonDistance(game.player, landerSite(game.planetId)) <= LANDER_RING_RADIUS

export function canDock(game: Game): boolean {
  return game.mode === 'space' && !game.transition && distance3(game.ship, game.dockPos) <= DOCK_RADIUS
}

export function canLand(game: Game): boolean {
  if (game.mode !== 'space' || game.transition) return false
  const planet = planetById(game.planetId)
  const distance = distance3(game.ship, game.earthPos)
  return distance < planet.spaceRadius + LAND_ZONE_HEIGHT && game.ship.speed <= LAND_MAX_SPEED
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
    return holdCount(game) > 0 || carryCount(game) > 0 ? 'FLY TO THE ISS' : 'FLY TO EARTH'
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
  if (!canLand(game)) return false
  game.transition = { kind: 'landing', t: 0, duration: TRANSITION_TIME }
  emitSpace(game, 'land', 'BEGIN DESCENT', 0, shipPoint(game))
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
  const dx = game.ship.x - game.earthPos.x
  const dz = game.ship.z - game.earthPos.z
  const length = Math.max(1e-6, Math.hypot(dx, dz))
  game.ship.vx = (dx / length) * 8
  game.ship.vz = (dz / length) * 8
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

export function buyItem(game: Game, id: string): boolean {
  if (game.phase !== 'playing' || game.mode !== 'docked') return false
  const item = SHOP_BY_ID[id]
  if (!item) return false
  if (hasUpgrade(game, id) && !item.repeatable) return false
  if (game.credits < item.cost) {
    emitSpace(game, 'block', 'NOT ENOUGH CREDITS', 0, shipPoint(game))
    return false
  }
  game.credits -= item.cost
  game.upgrades.push(id)
  if (id === 'o2tank') game.oxygen = Math.min(maxOxygen(game), game.oxygen + 30)
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
  const payout = deliverValue(batch, holdSlots(game))
  for (const item of batch) item.status = 'delivered'
  game.credits += payout.credits
  game.score += payout.credits
  game.delivered += batch.length
  game.bestBatch = Math.max(game.bestBatch, batch.length)
  emitSpace(game, 'deliver', `DELIVERED ${batch.length} PCS`, payout.credits, shipPoint(game))
  checkWin(game)
  return batch.length
}

function checkWin(game: Game) {
  if (deliveredCount(game) < planetJunkTotal(game)) return
  const planet = planetById(game.planetId)
  game.score += CLEAN_BONUS
  emitSpace(game, 'clean', `${planet.name.toUpperCase()} FULLY CLEANED`, CLEAN_BONUS, shipPoint(game))
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
    placePlayerAtLander(game)
    emitSurface(game, 'land', 'TOUCHDOWN', 0, playerPoint(game))
  }
}

function snapShipToDock(game: Game) {
  const ship = game.ship
  ship.x = game.dockPos.x
  ship.y = game.dockPos.y
  ship.z = game.dockPos.z
  ship.vx = 0
  ship.vz = 0
  ship.speed = 0
  ship.thrust = 0
  ship.boosting = false
}

// ------------------------------------------------------------------ updates

function updateBodies(game: Game, dt: number) {
  const planet = planetById(game.planetId)
  game.earthAngle = wrapAngle(game.earthAngle + planet.orbitRate * dt)
  game.issAngle = wrapAngle(game.issAngle + ISS_ORBIT_RATE * dt)
  game.moonAngle = wrapAngle(game.moonAngle + MOON_ORBIT_RATE * dt)
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
  game.oxygen = Math.max(0, game.oxygen - OXYGEN_DRAIN * dt)
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
  const speed = WALK_SPEED * (input.boost ? SPRINT_MULTIPLIER : 1)
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

  player.hopCooldown = Math.max(0, player.hopCooldown - dt)
  if (input.hop && onGround && player.hopCooldown <= 0) {
    player.vH = HOP_SPEED
    player.hopCooldown = HOP_COOLDOWN
  }

  if (player.h > 0 || player.vH > 0) {
    player.vH -= GRAVITY_BASE * planet.gravity * dt
    player.h += player.vH * dt
    if (player.h <= 0) {
      const impact = -player.vH
      player.h = 0
      player.vH = 0
      if (impact > HARD_LAND_SPEED) damageSuit(game, HARD_LAND_DAMAGE, 'HARD LANDING', playerPoint(game))
      else emitSurface(game, 'land', '', 0, playerPoint(game))
    }
  }

  updateVacuum(game)
  if (game.phase === 'playing') updateOxygen(game, dt)
}

function collideBodies(game: Game) {
  const ship = game.ship
  const earth = game.earthPos
  const moon = game.moonPos
  const planet = planetById(game.planetId)
  const bodies = [
    { x: 0, z: 0, radius: SUN_RADIUS + BODY_CLEARANCE * 2 },
    { x: earth.x, z: earth.z, radius: planet.spaceRadius + BODY_CLEARANCE },
    { x: moon.x, z: moon.z, radius: MOON_RADIUS + BODY_CLEARANCE },
  ]
  for (const body of bodies) {
    const dx = ship.x - body.x
    const dz = ship.z - body.z
    const distance = Math.hypot(dx, dz)
    if (distance >= body.radius || distance < 1e-6) continue
    const nx = dx / distance
    const nz = dz / distance
    ship.x = body.x + nx * body.radius
    ship.z = body.z + nz * body.radius
    const normalVelocity = ship.vx * nx + ship.vz * nz
    if (normalVelocity < 0) {
      ship.vx -= nx * normalVelocity * 1.35
      ship.vz -= nz * normalVelocity * 1.35
    }
    if (game.scrapeTimer <= 0) {
      game.scrapeTimer = 0.9
      emitSpace(game, 'scrape', 'HULL SCRAPE', 0, shipPoint(game))
    }
  }
}

function updateShip(game: Game, dt: number, input: Input) {
  const ship = game.ship
  ship.yaw = wrapAngle(ship.yaw + clamp(input.x, -1, 1) * SHIP_YAW_RATE * dt)
  const thrust = clamp(input.y, -1, 1)
  const boosting = input.boost || input.hop
  ship.thrust = thrust
  ship.boosting = boosting && thrust > 0.12
  let targetSpeed = 0
  if (thrust > 0.12) targetSpeed = (boosting ? boostSpeed(game) : shipSpeed(game)) * thrust
  else if (thrust < -0.12) targetSpeed = SHIP_REVERSE_SPEED * thrust

  const targetVx = Math.sin(ship.yaw) * targetSpeed
  const targetVz = Math.cos(ship.yaw) * targetSpeed
  const k = 1 - Math.exp(-SHIP_ACCEL_K * dt)
  ship.vx += (targetVx - ship.vx) * k
  ship.vz += (targetVz - ship.vz) * k
  ship.x += ship.vx * dt
  ship.z += ship.vz * dt
  ship.speed = Math.hypot(ship.vx, ship.vz)
  collideBodies(game)
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
  if (game.mode === 'surface') updateSurface(game, dt, input)
  else updateShip(game, dt, input)
}
