import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_BONUS, CARRY_SLOTS, CLEAN_BONUS, EARTH_RADIUS, FULL_HOLD_BONUS, HOLD_SLOTS,
  JUNK_POINTS, OXYGEN_DRAIN, OXYGEN_MAX, SUFFOCATION_DAMAGE, SURFACE_RADIUS, TRANSITION_TIME,
} from '../src/sim/config.ts'
import {
  bearingTo, buyItem, canDock, canLand, carryCount, contextLabel, createGame, deliverValue,
  deliveredCount, deposit, dock, hasUpgrade, holdCount, holdSlots, land, latLonDistance, maxOxygen,
  nearLander, placePlayerAtLander, planetJunkTotal, progressSummary, step, takeOff, undock,
} from '../src/sim/game.ts'
import { landerSite } from '../src/sim/planets.ts'
import { dailySeed } from '../src/sim/rng.ts'

const idle = { x: 0, y: 0, boost: false, hop: false }
const STEP = 1 / 120

function running(seed = 7) {
  const game = createGame({ seed })
  game.phase = 'playing'
  return game
}

function advance(game, seconds, input = idle) {
  for (let elapsed = 0; elapsed < seconds; elapsed += STEP) {
    step(game, Math.min(STEP, seconds - elapsed), input)
  }
}

function park(game, lat, lon) {
  game.player.lat = lat
  game.player.lon = lon
  game.player.h = 0
  game.player.vH = 0
}

function fakeJunk(game, status, count, cls = 'tech') {
  for (let i = 0; i < count; i++) {
    game.junk.push({
      id: game.nextId++, planet: 0, cls, lat: 0, lon: 0, status, spin: 0, yaw: 0,
    })
  }
}

function standOnDock(game) {
  game.mode = 'space'
  game.transition = null
  game.ship.x = game.dockPos.x
  game.ship.y = game.dockPos.y
  game.ship.z = game.dockPos.z
  game.ship.speed = 0
}

// ------------------------------------------------------------------ world

test('seeded runs are deterministic and different seeds differ', () => {
  const a = createGame({ seed: 99 })
  const b = createGame({ seed: 99 })
  const c = createGame({ seed: 100 })
  assert.deepEqual(a.junk, b.junk)
  assert.deepEqual(a.dockPos, b.dockPos)
  assert.equal(a.earthAngle, b.earthAngle)
  assert.notDeepEqual(a.junk, c.junk)
  assert.equal(dailySeed(new Date('2026-10-12T01:00:00Z')), dailySeed(new Date('2026-10-12T22:00:00Z')))
  assert.notEqual(dailySeed(new Date('2026-10-12T01:00:00Z')), dailySeed(new Date('2026-10-13T01:00:00Z')))
})

test('a run starts on the surface at the lander with a full tank and a full planet', () => {
  const game = createGame({ seed: 4 })
  assert.equal(game.phase, 'ready')
  assert.equal(game.mode, 'surface')
  assert.equal(game.oxygen, OXYGEN_MAX)
  assert.equal(game.health, 100)
  assert.equal(planetJunkTotal(game), 24)
  assert.ok(nearLander(game), 'player must spawn inside the lander ring')
  const site = landerSite(0)
  assert.ok(Math.abs(game.player.lat - site.lat) < 1e-9)
  assert.ok(Math.abs(game.player.lon - site.lon) < 1e-9)
  // no junk is allowed to sit on the pad
  for (const item of game.junk) {
    assert.ok(latLonDistance(item, site) > 6, 'junk spawns clear of the lander')
  }
})

test('planets, the moon and the ISS orbit over time', () => {
  const game = running(21)
  const earthBefore = { ...game.earthPos }
  const dockBefore = { ...game.dockPos }
  const issAngleBefore = game.issAngle
  advance(game, 2)
  assert.ok(Math.abs(game.issAngle - issAngleBefore - 0.5) < 1e-6, 'ISS sweeps 0.25 rad/s')
  const orbit = Math.hypot(game.dockPos.x - game.earthPos.x, game.dockPos.z - game.earthPos.z)
  assert.ok(orbit > 25 && orbit < 28, 'the dock point rides the ISS orbit')
  const issTravel = Math.hypot(
    game.dockPos.x - game.earthPos.x - (dockBefore.x - earthBefore.x),
    game.dockPos.z - game.earthPos.z - (dockBefore.z - earthBefore.z),
  )
  assert.ok(issTravel > 10 && issTravel < 16, 'ISS sweeps a wide arc in two seconds')
  assert.ok(Math.hypot(game.earthPos.x - earthBefore.x, game.earthPos.z - earthBefore.z) > 5,
    'Earth advances along its own orbit')
})

test('surface movement is frame-rate independent', () => {
  const results = [60, 120, 144].map(fps => {
    const game = running(31)
    for (let i = 0; i < fps; i++) step(game, 1 / fps, { x: 0, y: 1, boost: false, hop: false })
    return { lat: game.player.lat, lon: game.player.lon }
  })
  assert.ok(Math.abs(results[0].lat - results[2].lat) < 1e-9)
  assert.ok(results[0].lat > 0.1)
})

test('compass bearings point the right way', () => {
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0.4, lon: 0 })) < 1e-9)
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0, lon: 0.4 }) - Math.PI / 2) < 1e-6)
  assert.ok(Math.abs(bearingTo({ lat: 0, lon: 0 }, { lat: 0, lon: -0.4 }) + Math.PI / 2) < 1e-6)
})

// ----------------------------------------------------------------- oxygen

test('oxygen drains off-pad, refills at the lander and never drains in space', () => {
  const game = running(5)
  park(game, 0.5, 0.6)
  advance(game, 10)
  assert.ok(Math.abs(game.oxygen - (OXYGEN_MAX - OXYGEN_DRAIN * 10)) < 0.05)

  // walk back to the pad: instant refill
  game.oxygen = 40
  placePlayerAtLander(game)
  advance(game, 1.5)
  assert.equal(game.oxygen, OXYGEN_MAX)

  // space is a safe place for oxygen
  assert.ok(takeOff(game))
  advance(game, TRANSITION_TIME + 0.2)
  assert.equal(game.mode, 'space')
  game.oxygen = 50
  advance(game, 5)
  assert.equal(game.oxygen, 50)
})

test('the oxygen warning fires once below the threshold', () => {
  const game = running(6)
  park(game, 0.7, 0.6)
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

// ------------------------------------------------------------ junk & hold

test('the vacuum sweeps junk within its radius and stops at the carry cap', () => {
  const game = running(12)
  // stand exactly on each of the first ten pieces
  for (const item of game.junk.slice(0, 10)) {
    park(game, item.lat, item.lon)
    step(game, STEP, idle)
  }
  assert.equal(carryCount(game), CARRY_SLOTS)
  assert.equal(game.junk.filter(item => item.status === 'ground').length, 24 - CARRY_SLOTS)

  // far away junk is ignored
  const far = game.junk.find(item => item.status === 'ground')
  park(game, far.lat + 0.4, far.lon)
  step(game, STEP, idle)
  assert.equal(far.status, 'ground')
})

test('the Wide Scoop upgrade widens the vacuum radius', () => {
  const near = running(13)
  const far = running(13)
  far.upgrades.push('widescoop')
  const item = near.junk[0]
  // stand outside the base radius but inside the upgraded one
  park(near, item.lat + 3.2 / SURFACE_RADIUS, item.lon)
  park(far, item.lat + 3.2 / SURFACE_RADIUS, item.lon)
  step(near, STEP, idle)
  step(far, STEP, idle)
  assert.equal(near.junk[0].status, 'ground')
  assert.equal(far.junk[0].status, 'carried')
})

test('deposit stows carried junk and respects the hold capacity', () => {
  const game = running(14)
  for (const item of game.junk.slice(0, 3)) item.status = 'carried'
  placePlayerAtLander(game)
  assert.ok(deposit(game))
  assert.equal(holdCount(game), 3)
  assert.equal(carryCount(game), 0)

  // overflow: 30 in the hold, 5 carried
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

test('partial cleanup persists across takeoff and landing', () => {
  const game = running(17)
  for (const item of game.junk.slice(0, 4)) item.status = 'delivered'
  placePlayerAtLander(game)
  assert.ok(takeOff(game))
  advance(game, TRANSITION_TIME + 0.1)
  assert.equal(game.mode, 'space')
  assert.equal(deliveredCount(game), 4)

  game.ship.x = game.earthPos.x + EARTH_RADIUS + 8
  game.ship.z = game.earthPos.z
  game.ship.speed = 0
  assert.ok(canLand(game))
  game.ship.speed = 55
  assert.equal(canLand(game), false, 'too fast to land')
  game.ship.speed = 0
  assert.ok(canLand(game))
  assert.ok(land(game))
  advance(game, TRANSITION_TIME / 2)
  assert.equal(game.mode, 'space', 'still descending')
  advance(game, TRANSITION_TIME / 2 + 0.1)
  assert.equal(game.mode, 'surface')
  assert.ok(nearLander(game), 'landing puts you down at the pad')
  assert.equal(deliveredCount(game), 4, 'delivered junk stays delivered')
})

// -------------------------------------------------------------- shop & win

test('purchase rules: docked only, credits required, no double buys', () => {
  const game = running(18)
  game.credits = 1000
  assert.equal(buyItem(game, 'o2tank'), false, 'only while docked')
  game.mode = 'docked'
  assert.equal(buyItem(game, 'beacon'), false, 'too expensive')
  assert.equal(game.credits, 1000)
  assert.ok(buyItem(game, 'o2tank'))
  assert.equal(game.credits, 500)
  assert.equal(maxOxygen(game), 130)
  assert.equal(buyItem(game, 'o2tank'), false, 'one-shot item')
  game.credits = 5000
  assert.ok(buyItem(game, 'beacon'))
  assert.equal(hasUpgrade(game, 'beacon'), true)
  assert.equal(game.credits, 3800)
  game.upgrades = game.upgrades.filter(id => id !== 'beacon')
  assert.ok(buyItem(game, 'beacon'), 'beacon is repurchasable after a rescue')
})

test('cleaning the whole planet wins the run', () => {
  const game = running(19)
  const value = game.junk.reduce((sum, item) => sum + JUNK_POINTS[item.cls], 0)
  for (const item of game.junk) item.status = 'hold'
  standOnDock(game)
  assert.ok(dock(game))
  assert.equal(deliveredCount(game), 24)
  assert.equal(game.phase, 'finished')
  assert.equal(game.outcome, 'won')
  assert.equal(game.score, Math.round(value * (1 + BATCH_BONUS)) + CLEAN_BONUS)
  const summary = progressSummary(game)
  assert.equal(summary.delivered, summary.total)
})

// ------------------------------------------------------- modes & geometry

test('docking needs proximity to the ISS airlock', () => {
  const game = running(20)
  game.mode = 'space'
  game.ship.x = game.dockPos.x + 12
  game.ship.z = game.dockPos.z
  game.ship.speed = 0
  assert.equal(canDock(game), false)
  assert.equal(dock(game), false)
  game.ship.x = game.dockPos.x + 4
  assert.ok(canDock(game))
  assert.ok(dock(game))
  assert.equal(game.mode, 'docked')
  assert.ok(undock(game))
  assert.equal(game.mode, 'space')
})

test('takeoff and landing transitions switch modes on schedule', () => {
  const game = running(22)
  placePlayerAtLander(game)
  assert.ok(takeOff(game))
  assert.equal(game.mode, 'surface')
  assert.equal(game.transition.kind, 'takeoff')
  advance(game, TRANSITION_TIME / 2)
  assert.equal(game.mode, 'surface', 'still lifting off')
  advance(game, TRANSITION_TIME / 2 + 0.1)
  assert.equal(game.mode, 'space')
  assert.equal(game.transition, null)
  assert.equal(contextLabel(game), 'LAND', 'warm on the pad means we can land')

  game.ship.x = game.earthPos.x + EARTH_RADIUS + 40
  game.ship.z = game.earthPos.z
  assert.equal(contextLabel(game), 'FLY TO EARTH')
  game.ship.x = game.earthPos.x + EARTH_RADIUS + 10
  game.ship.z = game.earthPos.z
  assert.equal(contextLabel(game), 'LAND')
  assert.equal(takeOff(game), false, 'no takeoff from space')
})

test('the lander ring gates deposits and takeoff on the surface', () => {
  const game = running(23)
  park(game, 0.9, -0.9)
  assert.equal(contextLabel(game), 'RETURN TO LANDER')
  assert.equal(deposit(game), false)
  assert.equal(takeOff(game), false)
  placePlayerAtLander(game)
  assert.equal(contextLabel(game), 'TAKE OFF')
  for (const item of game.junk.slice(0, 2)) item.status = 'carried'
  assert.equal(contextLabel(game), 'DEPOSIT')
})
