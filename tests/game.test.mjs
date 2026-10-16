import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_BONUS, BATCH_BONUS_SIZE, BODY_CLEARANCE, CARRY_SLOTS, CLEAN_BONUS, EARTH_RADIUS, FULL_HOLD_BONUS,
  HARD_LAND_DAMAGE, HOLD_SLOTS, ISS_DOCK_OFFSET, ISS_ORBIT, JUNK_POINTS, METEOR_DAMAGE,
  METEOR_TELEGRAPH_BONUS, MOON_ORBIT, OXYGEN_DRAIN, OXYGEN_MAX, SCANNER_RANGE,
  SHIP_BOOST_SPEED, SHIP_SPEED, SPACE_SCALE, STARTING_DELIVERED, STORM_DRAIN_MULT, STORM_DURATION,
  STORM_PERIOD, STORM_PUSH, STORM_WIND_TURN, FINAL_SWEEP_MULT,
  SUFFOCATION_DAMAGE, EARTH_SURFACE_RADIUS, HEALTH_MAX, SURFACE_RADIUS, TRANSITION_TIME,
  SUN_BURN_RADIUS, SUN_DAMAGE_HEAT, SUN_HEAT_RADIUS, SUN_WARN_HEAT, SWEEP_STEP,
  SHIP_REVERSE_SPEED, SHIP_STRAFE_SPEED, THIRD_ENGINE_BONUS, MUSIC_RIVER_RANGE, MUSIC_SUN_RADIUS,
} from '../src/sim/config.ts'
import {
  allPlanetsClean, bearingTo, boostSpeed, buyItem, canDock, canLand, carryCount, contextLabel, createGame,
  deliverValue, deliveredCount, deposit, dock, hasRelic, hasUpgrade, holdCount, holdSlots, hopSpeed, land,
  landTarget, landingZone, latLonDistance, maxOxygen, nearLander, objective, placePlayerAtLander,
  planetJunkTotal, progressSummary, rankForScore, remainingCount, resetHazards, reverseSpeed, scannerPings,
  shipSpeed, strafeSpeed, step, sweepState, takeOff, undock, updateHazards, walkSpeed, systemReport,
  screenMoveVector, wrapAngle, musicFor,
} from '../src/sim/game.ts'
import { PLANETS, landerSite, landmarkDistance, surfaceRadiusOf } from '../src/sim/planets.ts'
import { fromPad } from '../src/sim/earthfield.ts'
import { SHOP_ITEMS } from '../src/sim/economy.ts'
import { decodeSave, encodeSave, restoreSave, serializeSave } from '../src/sim/save.ts'
import { dailySeed } from '../src/sim/rng.ts'
import { quatForward, quatToFlightAngles, quatUp } from '../src/sim/orient.ts'

const idle = { x: 0, y: 0, pitch: 0, yaw: 0, roll: 0, boost: false, hop: false }
const STEP = 1 / 120

function running(seed = 7) {
  const game = createGame({ seed })
  game.phase = 'playing'
  return game
}

/** A run parked on any planet's surface, hazards freshly armed. */
function grounded(seed, planetId = 0) {
  const game = running(seed)
  if (planetId !== 0) {
    game.mode = 'surface'
    game.planetId = planetId
    resetHazards(game)
    placePlayerAtLander(game)
  }
  return game
}

function flying(seed, x = 0, y = 1400 * SPACE_SCALE, z = 0) {
  const game = running(seed)
  game.mode = 'space'
  game.transition = null
  // level with the orbital plane, parked out in open space - which has to mean
  // outside the Sun's sphere of influence too, or the tug flies on real gravity
  // instead of the fly-by-wire handling these tests are about
  game.ship.q = { x: 0, y: 0, z: 0, w: 1 }
  game.ship.x = x
  game.ship.y = y
  game.ship.z = z
  // zero the VELOCITY, not just the cached speed readout: the sim derives what it
  // needs from the vector, so a fixture that only writes `speed` is lying about it
  game.ship.vx = 0
  game.ship.vy = 0
  game.ship.vz = 0
  game.ship.speed = 0
  return game
}

function advance(game, seconds, input = idle) {
  for (let elapsed = 0; elapsed < seconds; elapsed += STEP) {
    step(game, Math.min(STEP, seconds - elapsed), input)
  }
}

function advanceUntil(game, predicate, limit = 30, input = idle) {
  let elapsed = 0
  while (elapsed < limit && !predicate(game)) {
    step(game, STEP, input)
    elapsed += STEP
  }
  return elapsed
}

function park(game, lat, lon) {
  game.player.lat = lat
  game.player.lon = lon
  game.player.h = 0
  game.player.vH = 0
}

/**
 * How far one surface position is from another, as a north/east pair of distances in
 * surface units. The east leg is scaled by the latitude the walk crossed at, because a
 * degree of longitude is a shorter step up here than a degree of latitude.
 */
function surfaceOffset(from, to) {
  const midLat = (from.lat + to.lat) / 2
  return {
    north: (to.lat - from.lat) * SURFACE_RADIUS,
    east: wrapAngle(to.lon - from.lon) * Math.cos(midLat) * SURFACE_RADIUS,
  }
}

function standOnDock(game) {
  game.mode = 'space'
  game.transition = null
  game.ship.x = game.dockPos.x
  game.ship.y = game.dockPos.y
  game.ship.z = game.dockPos.z
  game.ship.vx = 0
  game.ship.vy = 0
  game.ship.vz = 0
  game.ship.speed = 0
}

/** the world's own velocity in the map frame - the same formula the sim uses */
function bodyVelocity(game, body) {
  const planet = PLANETS[body]
  const angle = body === 0 ? game.earthAngle : body === 1 ? game.moonAngle : game.marsAngle
  const speed = planet.orbit * planet.orbitRate
  const velocity = { x: -Math.sin(angle) * speed, y: 0, z: Math.cos(angle) * speed }
  if (body === 1) {
    const earth = bodyVelocity(game, 0)
    velocity.x += earth.x
    velocity.y += earth.y
    velocity.z += earth.z
  }
  return velocity
}

function parkOnPlanet(game, planetId, offset = 8 * SPACE_SCALE) {
  game.mode = 'space'
  game.transition = null
  const position = game.planetPos[planetId]
  game.ship.x = position.x + offset
  game.ship.y = position.y
  game.ship.z = position.z
  // co-moving with the world, because that is what "parked at a world" has to mean.
  // These worlds drift along their orbits at 57-84 u/s, so a ship sitting still in
  // the map frame is doing that whole speed relative to the planet it is parked on.
  const drift = bodyVelocity(game, planetId)
  game.ship.vx = drift.x
  game.ship.vy = drift.y
  game.ship.vz = drift.z
  game.ship.speed = Math.hypot(drift.x, drift.y, drift.z)
}

function onPlanet(game, planetId) {
  parkOnPlanet(game, planetId)
  assert.equal(landTarget(game), planetId)
  assert.ok(land(game))
  advance(game, TRANSITION_TIME + 0.1)
  assert.equal(game.mode, 'surface')
  assert.equal(game.planetId, planetId)
}

function fakeJunk(game, status, count, cls = 'tech') {
  for (let i = 0; i < count; i++) {
    game.junk.push({
      id: game.nextId++, planet: 0, cls, lat: 0, lon: 0, status, spin: 0, yaw: 0,
    })
  }
}

// ------------------------------------------------------------------ world

test('seeded runs are deterministic and different seeds differ', () => {
  const a = createGame({ seed: 99 })
  const b = createGame({ seed: 99 })
  const c = createGame({ seed: 100 })
  assert.deepEqual(a.junk, b.junk)
  assert.deepEqual(a.dockPos, b.dockPos)
  assert.deepEqual(a.planetPos, b.planetPos)
  assert.equal(a.earthAngle, b.earthAngle)
  assert.notDeepEqual(a.junk, c.junk)
  assert.equal(dailySeed(new Date('2026-10-12T01:00:00Z')), dailySeed(new Date('2026-10-12T22:00:00Z')))
  assert.notEqual(dailySeed(new Date('2026-10-12T01:00:00Z')), dailySeed(new Date('2026-10-13T01:00:00Z')))
})

test('a run starts on Earth at the lander with a full tank and a full system', () => {
  const game = createGame({ seed: 4 })
  assert.equal(game.phase, 'ready')
  assert.equal(game.mode, 'surface')
  assert.equal(game.oxygen, OXYGEN_MAX)
  assert.equal(game.health, 100)
  assert.equal(planetJunkTotal(game, 0), 24)
  assert.equal(planetJunkTotal(game, 1), 22)
  assert.equal(planetJunkTotal(game, 2), 22)
  assert.ok(nearLander(game), 'player must spawn inside the lander ring')
  const site = landerSite(0)
  assert.ok(Math.abs(game.player.lat - site.lat) < 1e-9)
  assert.ok(Math.abs(game.player.lon - site.lon) < 1e-9)
  for (const item of game.junk) {
    const lander = landerSite(item.planet)
    assert.ok(latLonDistance(item, lander) > 6, 'junk spawns clear of the lander')
  }
})

test('every planet hides exactly one relic, well away from its lander', () => {
  const game = createGame({ seed: 33 })
  for (const planet of PLANETS) {
    const relics = game.junk.filter(item => item.planet === planet.id && item.cls === 'relic')
    assert.equal(relics.length, 1, `${planet.name} has one relic`)
    assert.ok(latLonDistance(relics[0], landerSite(planet.id)) > 12, 'relics sit far from the pad')
  }
})

test('all three planets and the ISS orbit over time', () => {
  const game = running(21)
  const earthBefore = { ...game.planetPos[0] }
  const marsBefore = { ...game.planetPos[2] }
  const dockBefore = { ...game.dockPos }
  const issAngleBefore = game.issAngle
  advance(game, 2)
  assert.ok(Math.abs(game.issAngle - issAngleBefore - 0.5) < 1e-6, 'ISS sweeps 0.25 rad/s')
  const orbit = Math.hypot(game.dockPos.x - game.planetPos[0].x, game.dockPos.z - game.planetPos[0].z)
  assert.ok(orbit > ISS_ORBIT && orbit < ISS_ORBIT + ISS_DOCK_OFFSET + 1, 'the dock point rides the ISS orbit')
  const issTravel = Math.hypot(
    game.dockPos.x - game.planetPos[0].x - (dockBefore.x - earthBefore.x),
    game.dockPos.z - game.planetPos[0].z - (dockBefore.z - earthBefore.z),
  )
  assert.ok(issTravel > orbit * 0.4 && issTravel < orbit * 0.75, 'ISS sweeps a wide arc in two seconds')
  assert.ok(Math.hypot(game.planetPos[0].x - earthBefore.x, game.planetPos[0].z - earthBefore.z) > 5,
    'Earth advances along its own orbit')
  assert.ok(Math.hypot(game.planetPos[2].x - marsBefore.x, game.planetPos[2].z - marsBefore.z) > 0,
    'Mars advances too')
  const moonOrbit = Math.hypot(
    game.moonPos.x - game.planetPos[0].x, game.moonPos.z - game.planetPos[0].z,
  )
  assert.ok(Math.abs(moonOrbit - MOON_ORBIT) < 1e-6, 'the Moon rides its own orbit around Earth')
  assert.deepEqual(game.moonPos, game.planetPos[1], 'moonPos mirrors planetPos[1]')
})

test('surface movement is frame-rate independent', () => {
  const results = [60, 120, 144].map(fps => {
    const game = running(31)
    for (let i = 0; i < fps; i++) step(game, 1 / fps, { ...idle, y: 1 })
    return { lat: game.player.lat, lon: game.player.lon }
  })
  assert.ok(Math.abs(results[0].lat - results[2].lat) < 1e-9)
  // and that the janitor actually went somewhere. A second of walking is a
  // second of walking whatever the ball is sized at, so this is in metres.
  assert.ok(results[0].lat * EARTH_SURFACE_RADIUS > 4, 'a second of walking covers ground')
})

test('compass bearings point the right way', () => {
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0.4, lon: 0 })) < 1e-9)
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0, lon: 0.4 }) - Math.PI / 2) < 1e-6)
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0, lon: -0.4 }) + Math.PI / 2) < 1e-6)
})

// ------------------------------------------------------- free-freedom flight

test('the ship spawns on its pad, nose along the prograde vector', () => {
  const game = running(41)
  const forward = quatForward(game.ship.q)
  assert.ok(Math.abs(forward.y) < 1e-9, 'the nose is level with the orbital plane')
  const radial = {
    x: game.ship.x - game.planetPos[0].x,
    y: game.ship.y - game.planetPos[0].y,
    z: game.ship.z - game.planetPos[0].z,
  }
  const radialLength = Math.hypot(radial.x, radial.y, radial.z)
  const dot = (forward.x * radial.x + forward.y * radial.y + forward.z * radial.z) / radialLength
  assert.ok(Math.abs(dot) < 1e-6, 'the nose is perpendicular to local up (pointing prograde)')
})

test('pitch, yaw and roll inputs drive a full-freedom quaternion', () => {
  const pitched = flying(42)
  advance(pitched, 0.5, { ...idle, pitch: 1 })
  const forward = quatForward(pitched.ship.q)
  assert.ok(forward.y > 0.3, `pitching up lifts the nose (got ${forward.y.toFixed(3)})`)
  assert.ok(Math.abs(Math.sin(quatToFlightAngles(pitched.ship.q).pitch) - forward.y) < 1e-6)

  const yawed = flying(42)
  advance(yawed, 0.5, { ...idle, yaw: 1 })
  const yawForward = quatForward(yawed.ship.q)
  assert.ok(Math.abs(yawForward.y) < 1e-9, 'pure yaw keeps the nose level')
  assert.ok(yawForward.x < -0.5, 'yaw +1 swings the nose toward screen right (world -x)')

  const rolled = flying(42)
  advance(rolled, 0.5, { ...idle, roll: 1 })
  const rollAngle = quatToFlightAngles(rolled.ship.q).roll
  assert.ok(rollAngle > 0.6, `roll +1 banks right (got ${rollAngle.toFixed(3)})`)
  assert.ok(quatUp(rolled.ship.q).x < 0, 'the up vector leans toward screen right')
  const rolledForward = quatForward(rolled.ship.q)
  assert.ok(Math.abs(rolledForward.y) < 1e-9, 'rolling never changes the facing vector')
})

test('releasing the stick auto-banks back toward level flight', () => {
  const game = flying(43)
  advance(game, 0.4, { ...idle, roll: 1 })
  const banked = quatToFlightAngles(game.ship.q).roll
  advance(game, 2)
  const settled = quatToFlightAngles(game.ship.q).roll
  assert.ok(Math.abs(settled) < Math.abs(banked) * 0.6, 'the tug levels itself out')
})

test('thrust follows the facing vector, so the ship climbs when pitched up', () => {
  const game = flying(44)
  advance(game, 0.6, { ...idle, pitch: 1 })
  const before = game.ship.y
  advance(game, 1.5, { ...idle, y: 1 })
  assert.ok(game.ship.y > before + 5, 'nose-up thrust climbs')
  assert.ok(game.ship.vy > 0)
  const forward = quatForward(game.ship.q)
  assert.ok(Math.abs(game.ship.vx - forward.x * game.ship.speed) < 1e-6)
  assert.ok(Math.abs(game.ship.vz - forward.z * game.ship.speed) < 1e-6)
})

test('keyboard-style pitch/yaw fields behave exactly like any other input', () => {
  const mouse = flying(45)
  const keys = flying(45)
  advance(mouse, 1, { ...idle, pitch: 0.5, yaw: -0.25 })
  // arrow keys produce the same numbers the pointer-lock mouse would
  advance(keys, 1, { ...idle, pitch: 0.5, yaw: -0.25 })
  assert.deepEqual(mouse.ship.q, keys.ship.q)
})

test('space flight is frame-rate independent', () => {
  const results = [60, 120, 144].map(fps => {
    const game = flying(46)
    for (let i = 0; i < fps * 2; i++) step(game, 1 / fps, { ...idle, y: 1, boost: true })
    return { x: game.ship.x, y: game.ship.y, z: game.ship.z }
  })
  for (const result of results) {
    assert.ok(Math.abs(result.z - results[2].z) < 0.5, 'same flight path at any refresh rate')
    assert.ok(Math.abs(result.y - results[2].y) < 0.5)
  }
  assert.ok(results[0].z > 50, 'the boost actually goes somewhere')
})

test('the Sun pulls the tug in, and the corona cooks it', () => {
  const outside = flying(90, 0, SUN_HEAT_RADIUS + 2000, 0)
  advance(outside, 1.5, idle)
  assert.equal(outside.ship.heat, 0, 'nothing heats up outside the ring')
  assert.ok(Math.abs(outside.ship.vy) < 1, 'and nothing pulls out there either')

  const inside = flying(91, 0, SUN_BURN_RADIUS - 60, 0)
  advance(inside, 1, idle)
  assert.ok(inside.ship.heat > 0, 'inside the ring the hull takes heat')
  assert.ok(inside.ship.vy < -20, 'and the Sun is pulling the ship in')
  assert.ok(inside.ship.heat > SUN_WARN_HEAT, 'far enough in to be worth warning about')
  assert.ok(inside.events.some(event => event.kind === 'heat'), 'and it says so')
})

test('pulling back out takes the heat back out', () => {
  const game = flying(92, 0, SUN_BURN_RADIUS - 60, 0)
  advance(game, 1.2, idle)
  const hot = game.ship.heat
  assert.ok(hot > SUN_WARN_HEAT, 'hot to begin with')
  game.ship.y = SUN_HEAT_RADIUS + 900
  advance(game, 2, idle)
  assert.ok(game.ship.heat < hot, 'the sky cools it faster than the Sun heats it')
})

test('staying in the corona burns the hull through and ends the run', () => {
  const game = flying(93, 0, SUN_BURN_RADIUS - 60, 0)
  advance(game, 1, idle)
  assert.ok(game.health > 0, 'not dead yet')
  advanceUntil(game, state => state.phase === 'finished', 60, idle)
  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'lost')
  assert.equal(game.health, 0)
  assert.equal(game.ship.heat, 1)
  assert.ok(game.events.some(event => event.kind === 'lose'), 'and the shift is over')
})

test('the ship cannot fly through a planet', () => {
  const game = flying(47)
  const earth = game.planetPos[0]
  game.ship.x = earth.x
  game.ship.y = earth.y
  game.ship.z = earth.z + 22 * SPACE_SCALE
  game.ship.vz = -55 * SPACE_SCALE
  advance(game, 1)
  const distance = Math.hypot(
    game.ship.x - earth.x, game.ship.y - earth.y, game.ship.z - earth.z,
  )
  const shell = EARTH_RADIUS + BODY_CLEARANCE
  assert.ok(distance >= shell - 0.2, `hull clearance held (distance ${distance.toFixed(2)})`)
  assert.ok(game.events.some(event => event.kind === 'scrape'))
})

test('landing needs a slow approach to the right planet', () => {
  const game = flying(48)
  parkOnPlanet(game, 2, 10 * SPACE_SCALE)
  assert.equal(landTarget(game), 2)
  // "too fast" is measured relative to the world being landed on, not in the map
  // frame, so it takes the world's own drift plus an unambiguous sprint
  const drift = bodyVelocity(game, 2)
  game.ship.vx = drift.x + SHIP_BOOST_SPEED
  game.ship.vy = drift.y
  game.ship.vz = drift.z
  assert.equal(landTarget(game), -1, 'too fast to land')
  assert.equal(landingZone(game), 2, 'but still inside the zone')
  assert.equal(contextLabel(game), 'SLOW DOWN TO LAND')
  game.ship.vx = drift.x
  game.ship.vy = drift.y
  game.ship.vz = drift.z
  assert.equal(landTarget(game), 2)
  assert.equal(contextLabel(game), 'LAND')
  assert.equal(canLand(game), true)
  assert.ok(land(game))
  assert.equal(game.transition.kind, 'landing')
})

// ----------------------------------------------------------------- oxygen

test('oxygen drains off-pad, refills at the lander and never drains in space', () => {
  // on Mars, because Earth's air is breathable and the tanks are not the clock
  const game = running(5)
  game.planetId = 2
  placePlayerAtLander(game)
  park(game, 0.26 + 0.5, -0.85)
  advance(game, 10)
  assert.ok(Math.abs(game.oxygen - (OXYGEN_MAX - OXYGEN_DRAIN * 10)) < 0.05)

  game.oxygen = 40
  placePlayerAtLander(game)
  advance(game, 1.5)
  assert.equal(game.oxygen, OXYGEN_MAX)

  assert.ok(takeOff(game))
  advance(game, TRANSITION_TIME + 0.2)
  assert.equal(game.mode, 'space')
  game.oxygen = 50
  advance(game, 5)
  assert.equal(game.oxygen, 50)
})

test('the air on Earth is breathable, so the tanks are not the clock', () => {
  const game = running(66)
  park(game, 0.6, 0.9)
  advance(game, 120)
  assert.equal(game.oxygen, OXYGEN_MAX, 'two minutes off-pad costs no air')
  assert.equal(game.health, HEALTH_MAX, 'and never starts suffocating')
})

test('the oxygen warning fires once below the threshold', () => {
  const game = running(6)
  game.planetId = 2
  placePlayerAtLander(game)
  park(game, 0.26 + 0.7, -0.85)
  advance(game, 50)
  const warnings = game.events.filter(event => event.kind === 'oxygen' && event.text.includes('LOW'))
  assert.equal(warnings.length, 1)
  assert.ok(game.oxygen < 30)
})

test('suffocation at zero oxygen ends the run in a loss', () => {
  const game = running(8)
  park(game, 0.7, 0.6)
  game.oxygen = 0
  advance(game, 5)
  assert.ok(Math.abs(game.health - (100 - SUFFOCATION_DAMAGE * 5)) < 0.2)
  advance(game, 20)
  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'lost')
  assert.equal(game.health, 0)
})

test('the Emergency Beacon rescues exactly once', () => {
  const game = running(9)
  game.upgrades.push('beacon')
  park(game, 0.7, 0.6)
  game.oxygen = 0
  advance(game, 20)
  assert.equal(game.phase, 'playing')
  assert.equal(game.outcome, 'none')
  assert.ok(game.rescued)
  assert.equal(hasUpgrade(game, 'beacon'), false)
  assert.equal(game.health, 50)
  assert.ok(nearLander(game))

  game.oxygen = 0
  park(game, 0.7, 0.6)
  advance(game, 20)
  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'lost')
})

// ---------------------------------------------------------------- hazards

test('Moon: meteors telegraph, then hit whoever is still under the shadow', () => {
  const game = grounded(51, 1)
  park(game, 0.5, 1.2)
  advanceUntil(game, state => state.hazards.meteorTelegraph >= 0, 20)
  assert.ok(game.hazards.meteorTelegraph >= 0, 'a meteor is on the way')
  assert.ok(game.hazards.meteorDelay >= 2.5)
  const warnings = game.events.filter(event => event.kind === 'hint')
  assert.ok(warnings.length >= 1, 'the telegraph is announced')
  park(game, game.hazards.meteorLat, game.hazards.meteorLon)
  const health = game.health
  advance(game, game.hazards.meteorDelay + 0.1)
  assert.equal(game.health, health - METEOR_DAMAGE)
  assert.ok(game.events.some(event => event.kind === 'meteor'))
})

test('Moon: a meteor that lands far away costs nothing', () => {
  const game = grounded(52, 1)
  park(game, 0.5, 1.2)
  advanceUntil(game, state => state.hazards.meteorTelegraph >= 0, 20)
  // step well outside the blast radius (surface units -> radians)
  park(game, game.hazards.meteorLat + 25 / SURFACE_RADIUS, game.hazards.meteorLon)
  const health = game.health
  advance(game, game.hazards.meteorDelay + 0.1)
  assert.equal(game.health, health)
  assert.ok(game.events.some(event => event.kind === 'meteor'), 'the impact still happens')
})

test('Storm Sense telegraphs the meteor three seconds earlier', () => {
  const game = grounded(53, 1)
  game.relicTools.push('stormsense')
  park(game, 0.5, 1.2)
  advanceUntil(game, state => state.hazards.meteorTelegraph >= 0, 20)
  assert.ok(game.hazards.meteorDelay >= 2.5 + METEOR_TELEGRAPH_BONUS - 1e-9)
})

test('hazards stay silent on Earth and in orbit', () => {
  const game = running(54)
  park(game, 0.5, 0.6)
  advance(game, 20)
  assert.equal(game.hazards.meteorTelegraph, -1)
  assert.equal(game.hazards.stormActive, false)
  assert.equal(game.hazards.stormIntensity, 0)
  assert.equal(game.events.filter(event => event.kind === 'meteor').length, 0)
})

test('Mars: dust storms start on a timer, drain 35% more oxygen and carry you downwind', () => {
  const game = grounded(55, 2)
  // well clear of the pad, because the wind is about to move him and a storm that
  // carried him onto the ring would refill his oxygen and hide the drain
  park(game, 0.05, -0.5)
  assert.equal(game.hazards.stormTimer, STORM_PERIOD)
  game.hazards.stormTimer = 0.5
  advance(game, 1)
  assert.ok(game.hazards.stormActive, 'the storm arrived')
  assert.ok(game.events.some(event => event.kind === 'storm' || event.kind === 'hint'))

  // let the haze reach full strength, so what is measured is the storm at its worst
  advance(game, 1.5)
  assert.ok(game.hazards.stormIntensity > 0.9, 'haze reaches full strength')

  // drain rate: +35% while the storm blows
  game.oxygen = OXYGEN_MAX
  const from = { lat: game.player.lat, lon: game.player.lon }
  advance(game, 5)
  const drained = OXYGEN_MAX - game.oxygen
  assert.ok(Math.abs(drained - OXYGEN_DRAIN * STORM_DRAIN_MULT * 5) < 0.2,
    `storm drain was ${drained.toFixed(2)}`)

  // the wind carries him along the bearing it is blowing on, and not off to one side
  const moved = surfaceOffset(from, game.player)
  const carried = Math.hypot(moved.north, moved.east)
  assert.ok(carried > STORM_PUSH * 4.5, `the storm carried him ${carried.toFixed(2)} u`)
  const bearing = Math.atan2(moved.east, moved.north)
  assert.ok(Math.abs(wrapAngle(bearing - game.hazards.stormWindAngle)) < 0.05,
    `he was carried on ${bearing.toFixed(3)} but the wind blows on `
    + `${game.hazards.stormWindAngle.toFixed(3)}`)

  // and it blows over
  game.hazards.stormTime = STORM_DURATION - 0.2
  advance(game, 0.4)
  assert.equal(game.hazards.stormActive, false)
  assert.ok(game.hazards.stormTimer > STORM_PERIOD - 1, 'the next storm is already scheduled')
  advance(game, 3)
  assert.ok(game.hazards.stormIntensity < 0.1, 'haze clears')
})

test('Mars: no two storms in a row blow the same way', () => {
  const game = grounded(91, 2)
  park(game, 0.05, -0.5)
  const bearings = []
  for (let storm = 0; storm < 14; storm++) {
    game.hazards.stormTimer = 0.1
    advanceUntil(game, state => state.hazards.stormActive, 1)
    assert.ok(game.hazards.stormActive, `storm ${storm} arrived`)
    bearings.push(game.hazards.stormWindAngle)
    // blow this one over and let the air clear, so the next roll is a fresh one
    game.hazards.stormTime = STORM_DURATION
    advance(game, 0.4)
    advance(game, 2)
  }
  for (let i = 1; i < bearings.length; i++) {
    const turn = Math.abs(wrapAngle(bearings[i] - bearings[i - 1]))
    assert.ok(turn >= STORM_WIND_TURN - 1e-6,
      `storm ${i} turned only ${turn.toFixed(3)} rad from the one before it`)
  }
  // and it is a bearing, not a coin flip: the storms are not all one of two directions
  assert.ok(new Set(bearings.map(angle => angle.toFixed(1))).size > 6, 'the bearings vary')
})

test('Hazard Weave softens the blow of a direct meteor hit', () => {
  const game = grounded(56, 1)
  game.upgrades.push('hazardweave')
  park(game, 0.5, 1.2)
  advanceUntil(game, state => state.hazards.meteorTelegraph >= 0, 20)
  park(game, game.hazards.meteorLat, game.hazards.meteorLon)
  const health = game.health
  advance(game, game.hazards.meteorDelay + 0.1)
  assert.ok(Math.abs(game.health - (health - METEOR_DAMAGE * 0.6)) < 1e-6)
})

test('hazard timers are re-armed on every landing', () => {
  const game = grounded(57, 1)
  game.hazards.meteorTimer = 0.01
  resetHazards(game)
  assert.ok(game.hazards.meteorTimer >= 6 && game.hazards.meteorTimer <= 11)
  assert.equal(game.hazards.meteorTelegraph, -1)
  assert.equal(game.hazards.stormTimer, Infinity, 'the Moon has no storms')
  assert.equal(updateHazards !== undefined, true)
})

// ------------------------------------------------------------ junk & hold

test('the vacuum sweeps junk within its radius and stops at the carry cap', () => {
  const game = running(12)
  const earthGround0 = game.junk.filter(item => item.planet === 0 && item.status === 'ground').length
  // two of Earth's pieces arrived already delivered (plan §5.8), so walk to ground
  // pieces rather than to whatever happens to be first in the list
  for (const item of game.junk.filter(entry => entry.planet === 0 && entry.status === 'ground').slice(0, 10)) {
    park(game, item.lat, item.lon)
    step(game, STEP, idle)
  }
  assert.equal(carryCount(game), CARRY_SLOTS)
  const earthGround = game.junk.filter(item => item.planet === 0 && item.status === 'ground').length
  assert.equal(earthGround, earthGround0 - CARRY_SLOTS)

  const far = game.junk.find(item => item.planet === 0 && item.status === 'ground')
  park(game, far.lat + 0.4, far.lon)
  step(game, STEP, idle)
  assert.equal(far.status, 'ground')
})

test('the vacuum never picks up junk from another planet', () => {
  const game = grounded(58, 1)
  const moonJunk = game.junk.find(item => item.planet === 1 && item.status === 'ground')
  park(game, moonJunk.lat, moonJunk.lon)
  step(game, STEP, idle)
  assert.equal(moonJunk.status, 'carried')
  const touched = game.junk.filter(item => item.planet === 0 && (item.status === 'carried' || item.status === 'hold'))
  assert.equal(touched.length, 0, 'nothing on Earth was disturbed')
})

test('the Wide Scoop upgrade widens the vacuum radius', () => {
  const near = running(13)
  const far = running(13)
  far.upgrades.push('widescoop')
  const index = near.junk.findIndex(entry => entry.planet === 0 && entry.status === 'ground')
  const item = near.junk[index]
  park(near, item.lat + 3.2 / EARTH_SURFACE_RADIUS, item.lon)
  park(far, item.lat + 3.2 / EARTH_SURFACE_RADIUS, item.lon)
  step(near, STEP, idle)
  step(far, STEP, idle)
  assert.equal(near.junk[index].status, 'ground')
  assert.equal(far.junk[index].status, 'carried')
})

test('deposit stows carried junk and respects the hold capacity', () => {
  const game = running(14)
  for (const item of game.junk.slice(0, 3)) item.status = 'carried'
  placePlayerAtLander(game)
  assert.ok(deposit(game))
  assert.equal(holdCount(game), 3)
  assert.equal(carryCount(game), 0)

  const spare = running(14)
  while (spare.junk.length < 35) fakeJunk(spare, 'hold', 1)
  for (const item of spare.junk.slice(0, 30)) item.status = 'hold'
  for (const item of spare.junk.slice(30, 35)) item.status = 'carried'
  placePlayerAtLander(spare)
  assert.equal(holdSlots(spare), HOLD_SLOTS)
  assert.equal(deposit(spare), false, 'a full hold stows nothing')
  assert.equal(carryCount(spare), 5)
  spare.junk[0].status = 'delivered'
  assert.ok(deposit(spare))
  assert.equal(holdCount(spare), HOLD_SLOTS)
  assert.equal(carryCount(spare), 4)
})

test('Cargo Racks raise the hold capacity', () => {
  const game = running(15)
  assert.equal(holdSlots(game), HOLD_SLOTS)
  game.upgrades.push('cargoracks')
  assert.equal(holdSlots(game), HOLD_SLOTS + 24)
})

// ------------------------------------------------------------- deliveries

test('delivery bonuses scale with the batch', () => {
  const scrap = n => Array.from({ length: n }, () => ({ cls: 'scrap' }))
  assert.equal(deliverValue([{ cls: 'scrap' }, { cls: 'tech' }], HOLD_SLOTS).credits, 150)
  assert.equal(deliverValue(scrap(5), HOLD_SLOTS).credits, 200)
  assert.equal(deliverValue(scrap(6), HOLD_SLOTS).credits, Math.round(240 * (1 + BATCH_BONUS)))
  assert.equal(
    deliverValue(scrap(HOLD_SLOTS), HOLD_SLOTS).credits,
    Math.round(1200 * (1 + BATCH_BONUS + FULL_HOLD_BONUS)),
  )
  assert.equal(deliverValue([{ cls: 'hazardous' }], HOLD_SLOTS).credits, JUNK_POINTS.hazardous)
  assert.equal(deliverValue([{ cls: 'relic' }], HOLD_SLOTS).credits, JUNK_POINTS.relic)
})

// ------------------------------------------------------------- the sweep bet

test('a shift opens with the previous janitor\'s loads already aboard', () => {
  const game = running(80)
  const summary = progressSummary(game)
  assert.equal(summary.systemTotal, game.junk.length)
  assert.equal(summary.systemDelivered, STARTING_DELIVERED * PLANETS.length)
  for (const planet of PLANETS) {
    assert.equal(deliveredCount(game, planet.id), STARTING_DELIVERED)
    assert.equal(remainingCount(game, planet.id), planet.junkCount - STARTING_DELIVERED)
  }
  assert.equal(game.planetsCleaned, 0, 'no world is already clean')
  assert.equal(game.score, 0, 'and the head start is not paid for')
  assert.equal(game.credits, 0)
  assert.ok(
    game.junk.every(item => item.cls !== 'relic' || item.status === 'ground'),
    'a head start never costs a relic - those tools have to be earned',
  )
})

test('every piece in a sweep pays more than the one before it', () => {
  const game = running(81)
  const ground = game.junk.filter(item => item.planet === 0 && item.status === 'ground').slice(0, 4)
  const paid = []
  for (const item of ground) {
    park(game, item.lat, item.lon)
    step(game, STEP, idle)
    paid.push(item.mult)
  }
  assert.equal(carryCount(game), 4)
  assert.ok(Math.abs(paid[0] - 1) < 1e-9, 'the first piece is worth its class value')
  for (let i = 1; i < paid.length; i++) {
    assert.ok(paid[i] > paid[i - 1], `piece ${i + 1} pays more than piece ${i}`)
  }
  assert.ok(Math.abs(paid[3] - (1 + 3 * SWEEP_STEP)) < 1e-9)
  // the HUD shows the next one, which is the number the decision is about
  assert.ok(Math.abs(sweepState(game).multiplier - (1 + 4 * SWEEP_STEP)) < 1e-9)
})

test('stowing the haul, taking off or delivering resets the chain', () => {
  const armful = () => {
    const game = running(82)
    const ground = game.junk.filter(item => item.planet === 0 && item.status === 'ground').slice(0, 3)
    for (const item of ground) {
      park(game, item.lat, item.lon)
      step(game, STEP, idle)
    }
    assert.equal(game.sweep, 3)
    return game
  }

  const stowed = armful()
  placePlayerAtLander(stowed)
  assert.ok(deposit(stowed))
  assert.equal(stowed.sweep, 0, 'the arms are empty again')

  const flown = armful()
  placePlayerAtLander(flown)
  assert.ok(takeOff(flown))
  assert.equal(flown.sweep, 0, 'what is in hand is safe once you are off the ground')

  const shipped = armful()
  standOnDock(shipped)
  assert.ok(dock(shipped))
  assert.equal(shipped.sweep, 0, 'delivered cargo ends the sweep')
})

test('the sweep bet pays in score, not in credits', () => {
  const game = running(83)
  const ground = game.junk.filter(item => item.planet === 0 && item.status === 'ground').slice(0, 3)
  for (const item of ground) {
    park(game, item.lat, item.lon)
    step(game, STEP, idle)
  }
  // the scoop can take a neighbour along with the piece you walked to, so read the
  // batch off the game rather than assuming it is the three we aimed at
  const batch = game.junk.filter(item => item.status === 'carried' || item.status === 'hold')
  assert.ok(batch.length >= 2, 'a sweep of more than one piece')
  // the first piece of a sweep pays its class value exactly; the rest pay a premium
  assert.ok(batch.slice(1).every(item => item.mult > 1), 'every piece after the first is worth more')
  const value = batch.reduce((sum, item) => sum + JUNK_POINTS[item.cls], 0)
  const swept = batch.reduce((sum, item) => sum + JUNK_POINTS[item.cls] * item.mult, 0)
  const bonus = batch.length >= BATCH_BONUS_SIZE ? BATCH_BONUS : 0
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(game.credits, Math.round(value * (1 + bonus)), 'the market only ever sees class value')
  assert.equal(game.score, Math.round(swept * (1 + bonus)), 'the run is graded on what the bet paid')
  assert.ok(game.score > game.credits, 'and it did pay')
})

test('the last of a world is worth double', () => {
  const game = running(84)
  const earth = game.junk.filter(item => item.planet === 0 && item.status === 'ground')
  for (const item of earth.slice(0, earth.length - 3)) item.status = 'delivered'
  assert.equal(remainingCount(game, 0), 3)
  const state = sweepState(game)
  assert.ok(state.final, 'three pieces left of twenty-four is a final sweep')
  assert.ok(Math.abs(state.multiplier - FINAL_SWEEP_MULT) < 1e-9, 'with nothing in hand it is exactly double')

  // and it composes with the chain rather than replacing it
  const last = game.junk.filter(item => item.planet === 0 && item.status === 'ground')
  park(game, last[0].lat, last[0].lon)
  step(game, STEP, idle)
  assert.ok(Math.abs(last[0].mult - FINAL_SWEEP_MULT) < 1e-9)
  park(game, last[1].lat, last[1].lon)
  step(game, STEP, idle)
  assert.ok(Math.abs(last[1].mult - FINAL_SWEEP_MULT * (1 + SWEEP_STEP)) < 1e-9)
})

test('docking delivers the hold and the carry, paying credits and score', () => {
  const game = running(16)
  for (const item of game.junk.slice(0, 5)) item.status = 'hold'
  for (const item of game.junk.slice(5, 7)) item.status = 'carried'
  const value = game.junk.slice(0, 7).reduce((sum, item) => sum + JUNK_POINTS[item.cls], 0)
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(game.mode, 'docked')
  assert.equal(game.trips, 1)
  assert.equal(deliveredCount(game), 7)
  const expected = Math.round(value * (1 + BATCH_BONUS))
  assert.equal(game.credits, expected)
  assert.equal(game.score, expected)
  assert.equal(holdCount(game), 0)
  assert.equal(carryCount(game), 0)
  assert.equal(game.bestBatch, 7)
})

test('the pointer steers the janitor and the arrows move him where he faces', () => {
  const game = running()
  const withTurn = turn => ({ x: 0, y: 0, turn, pitch: 0, yaw: 0, roll: 0, boost: false, hop: false })
  const facing0 = game.player.facing
  advance(game, 0.4, withTurn(1))
  assert.ok(wrapAngle(game.player.facing - facing0) > 0.3, 'holding right swings him around')
  const turned = game.player.facing
  advance(game, 0.3, withTurn(0))
  assert.ok(Math.abs(wrapAngle(game.player.facing - turned)) < 1e-6, 'centred pointer holds the heading')
  // walk forward: the input layer rotated the arrow into his frame, so north
  // of his facing is where he goes
  const lat0 = game.player.lat
  advance(game, 1.5, { x: 0, y: 1, turn: 0, pitch: 0, yaw: 0, roll: 0, boost: false, hop: false })
  assert.ok(game.player.lat > lat0, 'forward walks where he looks')
  assert.ok(Math.abs(wrapAngle(game.player.facing - turned)) < 1e-6, 'movement never steals the facing')
})

test('screen arrows map into the mirror-handed world', () => {
  const up = screenMoveVector(0, 0, 1)
  assert.ok(Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9, 'pointer up + forward walks north')
  const right = screenMoveVector(0, 1, 0)
  assert.ok(right.x < -0.99 && Math.abs(right.y) < 1e-9, 'right side-step is screen-right (-east)')
  const atPointer = screenMoveVector(Math.PI / 2, 0, 1)
  assert.ok(atPointer.x < -0.99 && Math.abs(atPointer.y) < 1e-9, 'forward walks toward the pointer')
  assert.deepEqual(screenMoveVector(0, 0, 0), { x: 0, y: 0 })
})

test('space strafe slides the ship sideways without turning the nose', () => {
  const game = flying(71)
  advance(game, 2, { x: 1, y: 0, pitch: 0, yaw: 0, roll: 0, boost: false, hop: false })
  assert.ok(game.ship.vx < -8, `expected screen-right drift, got vx=${game.ship.vx.toFixed(1)}`)
  assert.ok(Math.abs(game.ship.vz) < 8, 'no forward speed from strafing alone')
  assert.ok(Math.abs(game.ship.q.x) < 1e-9 && Math.abs(game.ship.q.z) < 1e-9, 'the nose is unchanged')
})

test('partial cleanups persist per planet across takeoff and landing', () => {
  const game = running(17)
  // every world opens with STARTING_DELIVERED loads already aboard, so the test
  // measures against that baseline rather than against zero
  const baseline = PLANETS.map(planet => deliveredCount(game, planet.id))
  const earthItems = game.junk.filter(item => item.planet === 0 && item.status === 'ground')
  for (const item of earthItems.slice(0, 5)) item.status = 'delivered'
  placePlayerAtLander(game)
  assert.ok(takeOff(game))
  advance(game, TRANSITION_TIME + 0.1)
  assert.equal(game.mode, 'space')
  assert.equal(deliveredCount(game, 0), baseline[0] + 5)

  // out to the Moon: nothing delivered there yet, Earth's tally is untouched
  onPlanet(game, 1)
  assert.equal(deliveredCount(game, 0), baseline[0] + 5, 'delivered junk stays delivered')
  assert.equal(deliveredCount(game, 1), baseline[1])
  assert.equal(remainingCount(game, 1), 22 - baseline[1])
  assert.equal(game.planetId, 1)

  // sweep a couple of Moon pieces, hop home, still nothing on Earth changed
  const moonItems = game.junk
    .filter(item => item.planet === 1 && item.status === 'ground')
    .slice(0, 2)
  for (const item of moonItems) item.status = 'delivered'
  assert.ok(takeOff(game))
  advance(game, TRANSITION_TIME + 0.1)
  onPlanet(game, 0)
  assert.equal(game.planetId, 0)
  assert.equal(deliveredCount(game, 0), baseline[0] + 5)
  assert.equal(deliveredCount(game, 1), baseline[1] + 2, 'Moon progress persisted across the visit')
})

test('delivering a relic unlocks its tool for the rest of the run', () => {
  const game = running(59)
  const relic = game.junk.find(item => item.planet === 0 && item.cls === 'relic')
  relic.status = 'hold'
  standOnDock(game)
  assert.ok(dock(game))
  assert.ok(hasRelic(game, 'eye'), 'the Courier Drone Core brings Eye in the Sky online')
  assert.equal(game.relicTools.length, 1)
  assert.ok(game.events.some(event => event.kind === 'relic'))

  // a relic is never sold in the ISS shop, and a second delivery adds the next tool
  assert.ok(!SHOP_ITEMS.some(item => item.id === 'eye' || item.id === 'stride' || item.id === 'stormsense'))
  const moonRelic = game.junk.find(item => item.planet === 1 && item.cls === 'relic')
  moonRelic.status = 'hold'
  assert.ok(undock(game))
  standOnDock(game)
  assert.ok(dock(game))
  assert.deepEqual([...game.relicTools].sort(), ['eye', 'stride'])
  assert.ok(game.junk.every(item => item.cls !== 'relic' || item.planet === 2 || item.status === 'delivered'))
})

test('cleaning every planet wins the run, one clean bonus per world', () => {
  const game = running(19)
  // the works: everything not already aboard, swept in one batch at 1x, so the score
  // equals the credit payout exactly - the sweep bet only pays on pieces you scoop
  const batch = game.junk.filter(item => item.status !== 'delivered')
  const expected = deliverValue(batch, holdSlots(game)).credits + CLEAN_BONUS * PLANETS.length
  for (const item of batch) item.status = 'hold'
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(deliveredCount(game, 0), 24)
  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'won')
  assert.ok(allPlanetsClean(game))
  assert.equal(game.planetsCleaned, PLANETS.length)
  assert.equal(game.score, expected)
  const summary = progressSummary(game)
  assert.equal(summary.delivered, summary.total)
  assert.equal(summary.systemDelivered, summary.systemTotal)
})

test('cleaning one world alone does not end the run', () => {
  const game = running(60)
  for (const item of game.junk) if (item.planet === 0) item.status = 'hold'
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(game.phase, 'playing', 'still two worlds to sweep')
  assert.equal(game.planetsCleaned, 1)
  assert.equal(game.outcome, 'none')
  assert.equal(allPlanetsClean(game), false)
})

// ----------------------------------------------------------- guidance & HUD

test('the objective points at the ISS when carrying and at dirty worlds when empty', () => {
  const game = flying(61)
  const clean = objective(game)
  assert.equal(clean.kind, 'planet')
  assert.ok(PLANETS.some(planet => planet.name.toUpperCase() === clean.label))
  assert.equal(contextLabel(game), `FLY TO ${clean.label}`)

  const target = game.junk.find(item => item.planet === 1)
  target.status = 'hold'
  assert.equal(objective(game).kind, 'iss')
  assert.equal(contextLabel(game), 'FLY TO THE ISS')

  // fully cleaned worlds drop out of the rotation
  for (const item of game.junk) if (item.planet === clean.planetId) item.status = 'delivered'
  const next = objective(game)
  assert.notEqual(next.planetId, clean.planetId)
})

test('the Junk Scanner pings nearby junk; the Eye in the Sky tracks everything', () => {
  const blind = grounded(62, 0)
  assert.equal(scannerPings(blind).length, 0)

  const scanner = grounded(62, 0)
  scanner.upgrades.push('scanner')
  // stand at a piece: Earth's valley is a kilometre across and the scanner only
  // reaches thirty metres, so "somewhere on the ground" is no longer near enough
  const piece = scanner.junk.find((item) => item.planet === 0 && item.status === 'ground')
  park(scanner, piece.lat + 2 / EARTH_SURFACE_RADIUS, piece.lon)
  const pings = scannerPings(scanner)
  assert.ok(pings.length > 0, 'the scanner sees the junk')
  assert.ok(pings.every(ping => ping.distance <= SCANNER_RANGE))
  assert.ok(pings.every(ping => ping.distance >= 0 && Math.abs(ping.bearing) <= Math.PI))

  const eye = grounded(62, 0)
  eye.relicTools.push('eye')
  park(eye, 0.30, 0.60)
  const everything = scannerPings(eye)
  assert.equal(everything.length, 24 - STARTING_DELIVERED, 'the Eye tracks every piece still on the planet')
  assert.ok(everything.some(ping => ping.distance > SCANNER_RANGE), 'including the far ones')
})

test('the Nav Computer reports what is left on every world', () => {
  const game = running(63)
  assert.equal(systemReport(game), null)
  game.upgrades.push('navcomputer')
  const report = systemReport(game)
  assert.equal(report.length, 3)
  assert.deepEqual(
    report.map(entry => entry.remaining),
    PLANETS.map(planet => planet.junkCount - STARTING_DELIVERED),
  )
  assert.equal(report[1].name, 'Moon')
})

// -------------------------------------------------------------- shop effects

test('purchase rules: docked only, credits required, prerequisites and repeatables', () => {
  const game = running(18)
  game.credits = 1000
  assert.equal(buyItem(game, 'o2tank'), false, 'only while docked')
  game.mode = 'docked'
  assert.equal(buyItem(game, 'beacon'), false, 'too expensive')
  assert.equal(game.credits, 1000)
  assert.equal(buyItem(game, 'o2tank2'), false, 'O2 Tank II needs Tank I first')
  assert.ok(buyItem(game, 'o2tank'))
  assert.equal(game.credits, 500)
  assert.equal(maxOxygen(game), 130)
  assert.equal(buyItem(game, 'o2tank'), false, 'one-shot item')
  assert.equal(buyItem(game, 'o2tank2'), false, 'still short of credits')
  game.credits = 5000
  assert.ok(buyItem(game, 'o2tank2'))
  assert.equal(maxOxygen(game), 170)
  assert.ok(buyItem(game, 'beacon'))
  assert.equal(hasUpgrade(game, 'beacon'), true)
  assert.equal(game.credits, 5000 - 900 - 1200)
  game.upgrades = game.upgrades.filter(id => id !== 'beacon')
  assert.ok(buyItem(game, 'beacon'), 'beacon is repurchasable after a rescue')
})

test('suit upgrades actually change the walk, hop and landing numbers', () => {
  const game = running(64)
  assert.equal(walkSpeed(game, false), 7.4)
  assert.equal(hopSpeed(game), 11.5)
  const plain = walkSpeed(game, false)
  game.upgrades.push('magboots')
  assert.ok(Math.abs(walkSpeed(game, false) - plain * 1.15) < 1e-9)
  game.relicTools.push('stride')
  assert.ok(Math.abs(walkSpeed(game, false) - plain * 1.15 * 1.2) < 1e-9)
  game.upgrades.push('gravharness')
  assert.ok(Math.abs(hopSpeed(game) - 11.5 * 1.25) < 1e-9)
})

test('Grav Harness and Surefoot Stride turn hard landings into soft ones', () => {
  const impact = (upgrades, tools) => {
    const game = grounded(65, 1)
    game.upgrades.push(...upgrades)
    game.relicTools.push(...tools)
    park(game, 0.5, 1.2)
    game.player.h = 4
    game.player.vH = -16
    advance(game, 3)
    return game.health
  }
  assert.equal(impact([], []), 100 - HARD_LAND_DAMAGE, 'a 19 u/s landing hurts')
  assert.equal(impact(['gravharness'], []), 100)
  assert.equal(impact([], ['stride']), 100)
})

test('Recycler Mask slows the oxygen clock, O2 tanks stretch it', () => {
  const game = running(66)  // Earth has no storm to confuse the drain
  park(game, 0.6, 0.6)
  const start = game.oxygen
  advance(game, 10)
  const plainDrain = start - game.oxygen
  const masked = running(66)
  masked.upgrades.push('recycler')
  park(masked, 0.6, 0.6)
  masked.oxygen = start
  advance(masked, 10)
  const maskedDrain = start - masked.oxygen
  assert.ok(Math.abs(maskedDrain - plainDrain * 0.8) < 0.05)
  masked.upgrades.push('o2tank', 'o2tank2')
  assert.equal(maxOxygen(masked), OXYGEN_MAX + 70)
})

test('the dorsal third engine doubles every commanded speed', () => {
  const game = flying(75)
  assert.equal(shipSpeed(game), SHIP_SPEED)
  assert.equal(boostSpeed(game), SHIP_BOOST_SPEED)
  assert.equal(reverseSpeed(game), SHIP_REVERSE_SPEED)
  assert.equal(strafeSpeed(game), SHIP_STRAFE_SPEED)

  game.upgrades.push('thirdengine')
  assert.equal(shipSpeed(game), SHIP_SPEED * THIRD_ENGINE_BONUS, 'twice the cruise')
  assert.equal(boostSpeed(game), SHIP_BOOST_SPEED * THIRD_ENGINE_BONUS)
  assert.equal(reverseSpeed(game), SHIP_REVERSE_SPEED * THIRD_ENGINE_BONUS, 'twice the brakes as well')
  assert.equal(strafeSpeed(game), SHIP_STRAFE_SPEED * THIRD_ENGINE_BONUS)

  // and it stacks on the Thruster Kit instead of replacing it
  game.upgrades.push('thrusterkit')
  assert.ok(Math.abs(shipSpeed(game) - SHIP_SPEED * 1.25 * THIRD_ENGINE_BONUS) < 1e-9)
})

test('a tug with the third engine crosses twice the ground in the same time', () => {
  const flown = (engine) => {
    const game = flying(76)
    if (engine) game.upgrades.push('thirdengine')
    advance(game, 4, { ...idle, y: 1 })
    return Math.hypot(game.ship.vx, game.ship.vy, game.ship.vz)
  }
  const plain = flown(false)
  const fast = flown(true)
  assert.ok(Math.abs(plain - SHIP_SPEED) < 1, `a plain tug settles at cruise (${plain})`)
  assert.ok(Math.abs(fast / plain - 2) < 0.02, `expected twice the speed, got ${(fast / plain).toFixed(3)}x`)
})

test('Thruster Kit and Docking Assist change the ship numbers', () => {
  const game = flying(67)
  assert.equal(shipSpeed(game), SHIP_SPEED)
  game.upgrades.push('thrusterkit')
  assert.ok(Math.abs(shipSpeed(game) - SHIP_SPEED * 1.25) < 1e-9)
  const plain = flying(68)
  plain.ship.x = plain.dockPos.x + 8
  plain.ship.y = plain.dockPos.y
  plain.ship.z = plain.dockPos.z
  assert.equal(canDock(plain), false)
  const assisted = flying(68)
  assisted.upgrades.push('dockingassist')
  assisted.ship.x = assisted.dockPos.x + 8
  assisted.ship.y = assisted.dockPos.y
  assisted.ship.z = assisted.dockPos.z
  assert.equal(canDock(assisted), true, 'a wider dock radius reaches further')
})

// ------------------------------------------------------------ ranks & stats

test('ranks follow the tuned score thresholds', () => {
  assert.equal(rankForScore(0), 'BRONZE')
  assert.equal(rankForScore(3999), 'BRONZE')
  assert.equal(rankForScore(4000), 'SILVER')
  assert.equal(rankForScore(8999), 'SILVER')
  assert.equal(rankForScore(9000), 'GOLD')
  assert.equal(rankForScore(12499), 'GOLD')
  assert.equal(rankForScore(12500), 'PLATINUM')
  assert.equal(rankForScore(14499), 'PLATINUM')
  assert.equal(rankForScore(14500), 'LEGEND')
  assert.equal(rankForScore(999999), 'LEGEND')
})

test('the run tracks the stats the results screen shows', () => {
  const game = running(69)
  for (const item of game.junk.slice(0, 9)) item.status = 'hold'
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(game.delivered, 9)
  assert.equal(game.bestBatch, 9)
  assert.equal(game.trips, 1)
  assert.equal(game.planetsCleaned, 0)
  assert.equal(progressSummary(game).planetsCleaned, 0)
})

// ------------------------------------------------------------------- music

test('Earth has one landmark, and it is reachable on foot', () => {
  const radius = surfaceRadiusOf(0)
  const pad = landerSite(0)
  assert.equal(landmarkDistance(1, 0, 0), Infinity, 'the Moon has no landmark yet')
  assert.equal(landmarkDistance(2, 0, 0), Infinity, 'nor Mars - its storm is a hazard, not a place')
  const atPad = landmarkDistance(0, pad.lat, pad.lon)
  assert.ok(atPad > MUSIC_RIVER_RANGE, `the pad is clear of the river (${Math.round(atPad)} m)`)

  // sweep the valley for its closest approach: this is also the assertion that the
  // river trigger is reachable at all, since a range nobody can walk into is a track
  // that never plays
  let best = { distance: Infinity, lat: 0, lon: 0, arc: 0, bearing: 0 }
  for (let bearing = 0; bearing < 360; bearing += 15) {
    for (let arc = 20; arc <= 500; arc += 10) {
      const radians = (bearing * Math.PI) / 180
      const spot = fromPad(pad.lat, pad.lon, Math.cos(radians) * arc, Math.sin(radians) * arc, radius)
      const distance = landmarkDistance(0, spot.lat, spot.lon)
      if (distance < best.distance) best = { distance, lat: spot.lat, lon: spot.lon, arc, bearing }
    }
  }
  assert.ok(
    best.distance < MUSIC_RIVER_RANGE,
    `the water is walkable from the pad (closest ${Math.round(best.distance)} m at ${best.arc} m on ${best.bearing} deg)`,
  )
  // the east bank, where the ground still counts as land: the river cuts a channel, so
  // a point just inside the range is bank rather than water
  assert.ok(best.distance >= 0)
})

test('the music bed follows where you are and what is coming for you', () => {
  const earth = grounded(90, 0)
  assert.equal(musicFor(earth), 'earth', 'the valley gets the ambient bed')

  const space = flying(90)
  assert.equal(musicFor(space), 'space')
  // the Sun's bed has to arrive before the heat does. The ship is parked 14 km above
  // the plane, so closing on the Sun means moving all three axes.
  const nearSun = (factor) => {
    space.ship.x = MUSIC_SUN_RADIUS * factor
    space.ship.y = 0
    space.ship.z = 0
    return musicFor(space)
  }
  assert.equal(nearSun(0.9), 'sun')
  assert.equal(nearSun(1.1), 'space')
  // the band is the corona, so the music cannot play before the hull heats
  assert.equal(MUSIC_SUN_RADIUS, SUN_HEAT_RADIUS, 'the music is the heat')

  const moon = grounded(90, 1)
  assert.equal(musicFor(moon), 'moon')

  const mars = grounded(90, 2)
  assert.equal(musicFor(mars), 'mars')
  mars.hazards.stormActive = true
  assert.equal(musicFor(mars), 'storm', 'the storm takes the bed over')
  mars.hazards.stormActive = false
  assert.equal(musicFor(mars), 'mars')

  // a run that is not being played is silent: title, pause, results
  earth.phase = 'paused'
  assert.equal(musicFor(earth), null)
  earth.phase = 'playing'
  earth.mode = 'docked'
  assert.equal(musicFor(earth), 'space', 'docked at the ISS is still orbit')
})

test('the river takes precedence over the valley bed', () => {
  const game = grounded(92, 0)
  const radius = surfaceRadiusOf(0)
  const pad = landerSite(0)
  assert.equal(musicFor(game), 'earth')
  // find water and stand on it
  let spot = null
  for (let bearing = 0; bearing < 360 && !spot; bearing += 15) {
    for (let arc = 20; arc <= 500 && !spot; arc += 10) {
      const radians = (bearing * Math.PI) / 180
      const candidate = fromPad(pad.lat, pad.lon, Math.cos(radians) * arc, Math.sin(radians) * arc, radius)
      if (landmarkDistance(0, candidate.lat, candidate.lon) < MUSIC_RIVER_RANGE) spot = candidate
    }
  }
  assert.ok(spot, 'found the river')
  park(game, spot.lat, spot.lon)
  assert.equal(musicFor(game), 'river')
})

// --------------------------------------------------------------------- save

function progressedRun() {
  const game = running(71)
  const earth = game.junk.filter(item => item.planet === 0)
  for (const item of earth.slice(0, 6)) item.status = 'delivered'
  for (const item of earth.slice(6, 9)) item.status = 'hold'
  const relic = game.junk.find(item => item.planet === 1 && item.cls === 'relic')
  relic.status = 'delivered'
  game.mode = 'space'
  game.transition = null
  game.credits = 1234
  game.score = 4321
  game.upgrades.push('scanner', 'widescoop')
  game.relicTools.push('stride')
  game.delivered = 7
  game.bestBatch = 6
  game.trips = 2
  game.planetsCleaned = 0
  game.oxygen = 63.5
  game.health = 91
  game.time = 128.25
  game.planetId = 1
  parkOnPlanet(game, 1, 12)
  return game
}

test('save → encode → decode → restore round-trips the whole run', () => {
  const game = progressedRun()
  const text = encodeSave(serializeSave(game, 1234567))
  const data = decodeSave(text)
  assert.ok(data, 'the encoded save decodes')
  assert.equal(data.savedAt, 1234567)
  const restored = restoreSave(data)
  assert.ok(restored, 'the save restores')
  assert.equal(restored.seed, game.seed)
  assert.equal(restored.phase, 'playing')
  assert.equal(restored.mode, 'space')
  assert.equal(restored.planetId, 1)
  assert.equal(restored.credits, 1234)
  assert.equal(restored.score, 4321)
  assert.equal(restored.delivered, 7)
  assert.equal(restored.bestBatch, 6)
  assert.equal(restored.trips, 2)
  assert.equal(restored.health, 91)
  assert.ok(Math.abs(restored.oxygen - 63.5) < 1e-9)
  assert.ok(Math.abs(restored.time - 128.25) < 1e-9)
  assert.deepEqual(restored.upgrades.sort(), ['scanner', 'widescoop'])
  assert.deepEqual(restored.relicTools, ['stride'])
  assert.deepEqual(
    restored.junk.map(item => item.status),
    game.junk.map(item => item.status),
    'per-planet junk status survives the round trip',
  )
  assert.ok(Math.abs(restored.ship.x - game.ship.x) < 1e-9)
  assert.ok(Math.abs(restored.ship.q.w - game.ship.q.w) < 1e-9)
  assert.equal(deliveredCount(restored, 1), STARTING_DELIVERED + 1, 'the Moon relic stays delivered')
})

test('a restored surface run puts the janitor back on the right planet', () => {
  const game = grounded(72, 2)
  park(game, 0.42, -0.77)
  game.credits = 300
  const restored = restoreSave(decodeSave(encodeSave(serializeSave(game))))
  assert.ok(restored)
  assert.equal(restored.mode, 'surface')
  assert.equal(restored.planetId, 2)
  assert.ok(Math.abs(restored.player.lat - 0.42) < 1e-9)
  assert.ok(Math.abs(restored.player.lon + 0.77) < 1e-9)
  assert.equal(restored.credits, 300)
})

test('corrupt or unusable saves are rejected instead of crashing', () => {
  assert.equal(decodeSave(null), null)
  assert.equal(decodeSave(''), null)
  assert.equal(decodeSave('not json at all'), null)
  assert.equal(decodeSave('[1,2,3]'), null)
  assert.equal(decodeSave('{"v":99,"seed":1,"mode":"space","junk":[],"ship":[0,0,0],"player":[0,0,0],"angles":[0,0,0,0],"upgrades":[],"relicTools":[]}'), null,
    'a save from the future is ignored')
  assert.equal(decodeSave('{"v":1,"seed":1,"mode":"hunting"}'), null, 'unknown modes are rejected')

  const game = running(73)
  const data = serializeSave(game)
  data.junk = data.junk.slice(0, data.junk.length - 1)
  assert.equal(restoreSave(data), null, 'a mismatched junk layout is rejected')

  const broken = serializeSave(game)
  broken.ship = [NaN, 0, 0]
  assert.equal(restoreSave(broken), null, 'a ship that cannot be placed is rejected')
})

test('a structurally valid save with nonsense numbers degrades gracefully', () => {
  const game = running(74)
  const data = serializeSave(game)
  data.credits = -500
  data.health = 10000
  data.oxygen = -3
  data.time = Number.NaN
  data.junk = data.junk.map(() => 42)
  data.upgrades = ['scanner', 'not-a-real-upgrade']
  data.relicTools = ['eye', 'made-up-tool']
  data.planetId = 99
  const restored = restoreSave(data)
  assert.ok(restored, 'it still loads')
  assert.equal(restored.credits, 0)
  assert.equal(restored.health, 100)
  assert.equal(restored.oxygen, 0)
  assert.equal(restored.time, 0)
  assert.equal(restored.planetId, PLANETS.length - 1)
  assert.deepEqual(restored.upgrades, ['scanner'])
  assert.deepEqual(restored.relicTools, ['eye'])
  // every code is nonsense, so every piece falls back to the state the seed gives it:
  // on the ground, except the loads that were already aboard
  assert.ok(restored.junk.every(item => item.status === 'ground' || item.status === 'delivered'))
  assert.equal(
    restored.junk.filter(item => item.status === 'delivered').length,
    STARTING_DELIVERED * PLANETS.length,
  )
})

test('a restored run keeps stepping', () => {
  const game = progressedRun()
  const restored = restoreSave(decodeSave(encodeSave(serializeSave(game))))
  const before = { x: restored.ship.x, z: restored.ship.z }
  advance(restored, 1, { ...idle, y: 1 })
  assert.ok(Math.hypot(restored.ship.x - before.x, restored.ship.z - before.z) > 5)
  assert.equal(restored.phase, 'playing')
})

// ------------------------------------------------------- modes & geometry

test('docking needs proximity to the ISS airlock', () => {
  const game = flying(20)
  game.ship.x = game.dockPos.x + 12
  game.ship.y = game.dockPos.y
  game.ship.z = game.dockPos.z
  assert.equal(canDock(game), false)
  assert.equal(dock(game), false)
  game.ship.x = game.dockPos.x + 4
  assert.ok(canDock(game))
  assert.ok(dock(game))
  assert.ok(undock(game))
  assert.equal(game.mode, 'space')
  assert.ok(game.ship.speed > 0, 'undocking pushes the tug off the hatch')
})

test('a full three-planet run plays through to SYSTEM RESTORED', () => {
  const game = running(77)
  for (const planet of PLANETS) {
    if (game.planetId !== planet.id) onPlanet(game, planet.id)
    assert.equal(game.planetId, planet.id)

    const groundLeft = () => game.junk.filter(entry => entry.planet === planet.id && entry.status === 'ground').length
    let guard = 0
    while (groundLeft() > 0 && guard++ < 12) {
      // walk the whole planet, one piece at a time, then stow the haul
      for (const item of game.junk) {
        if (item.planet !== planet.id || item.status !== 'ground') continue
        park(game, item.lat, item.lon)
        step(game, STEP, idle)
      }
      placePlayerAtLander(game)
      deposit(game)
    }
    assert.equal(groundLeft(), 0, `${planet.name} has nothing left on the ground`)
    // two of every world's loads were already aboard when the shift opened
    assert.equal(holdCount(game), planet.junkCount - STARTING_DELIVERED, `${planet.name} is fully stowed`)

    assert.ok(takeOff(game))
    advance(game, TRANSITION_TIME + 0.1)
    assert.equal(game.mode, 'space')
    standOnDock(game)
    assert.ok(dock(game))
    if (planet.id < PLANETS.length - 1) {
      assert.ok(undock(game))
      assert.equal(game.phase, 'playing', `${planet.name} delivered, run continues`)
    }
  }

  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'won')
  assert.equal(game.planetsCleaned, 3)
  assert.equal(game.relicTools.length, 3, 'all three relics came home')
  assert.ok(allPlanetsClean(game))
  // walking the field in one pass fills the arms before turning back, so the sweep bet
  // pays: a full clean run lands PLATINUM, and LEGEND is the same run played deeper
  // (the ladder is measured in .tools/sweep-economy.mjs, plan §5.8)
  assert.ok(game.score > 5000, `a full run is worth real points (${game.score})`)
  assert.equal(
    rankForScore(game.score), 'PLATINUM',
    `finishing the system is PLATINUM, not ${rankForScore(game.score)} (${game.score})`,
  )
  assert.ok(game.score > game.credits, `the sweeps paid (score ${game.score} vs credits ${game.credits})`)
})
