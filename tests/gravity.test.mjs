import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EARTH_MU, EARTH_RADIUS, EARTH_SURFACE_G, GRAVITY_SOI, ISS_DOCK_OFFSET, ISS_ORBIT, ISS_ORBIT_RATE,
  LAND_ZONE_HEIGHT, PLANET_MU, SHIP_SPEED,
} from '../src/sim/config.ts'
import { canLand, createGame, dock, step, undock } from '../src/sim/game.ts'
import { PLANETS } from '../src/sim/planets.ts'

const idle = { x: 0, y: 0, pitch: 0, yaw: 0, roll: 0, boost: false, hop: false }

const running = (seed = 7) => {
  const game = createGame({ seed })
  game.phase = 'playing'
  game.mode = 'space'
  game.transition = null
  step(game, 0, idle) // settle the body positions without advancing time
  return game
}

/** the world's own velocity - the same formula the sim uses, written out again */
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

/** park the tug in space `radius` from a world, at world angle `angle`, co-moving
 *  with that world plus `speed` along the tangent (and `radial` along the radius). */
function orbitAt(game, body, radius, speed, { radial = 0, angle = null } = {}) {
  const centre = game.planetPos[body]
  const heading = angle ?? game.earthAngle
  const ship = game.ship
  ship.x = centre.x + radius * Math.cos(heading)
  ship.y = centre.y
  ship.z = centre.z + radius * Math.sin(heading)
  const drift = bodyVelocity(game, body)
  ship.vx = drift.x - Math.sin(heading) * speed + Math.cos(heading) * radial
  ship.vy = drift.y
  ship.vz = drift.z + Math.cos(heading) * speed + Math.sin(heading) * radial
  ship.speed = Math.hypot(ship.vx, ship.vy, ship.vz)
  return ship
}

/** the direction away from the Moon as seen from Earth, so a probe's own well is
 *  the one under test and not the Moon's */
const awayFromMoon = (game) => game.earthAngle + Math.PI + (game.moonAngle - game.earthAngle)

/** the ship's velocity relative to a world, and its distance from it */
function relative(game, body) {  const centre = game.planetPos[body]
  const drift = bodyVelocity(game, body)
  const dx = game.ship.x - centre.x
  const dy = game.ship.y - centre.y
  const dz = game.ship.z - centre.z
  const vx = game.ship.vx - drift.x
  const vy = game.ship.vy - drift.y
  const vz = game.ship.vz - drift.z
  return { radius: Math.hypot(dx, dy, dz), speed: Math.hypot(vx, vy, vz), dx, dy, dz, vx, vy, vz }
}

function run(game, seconds, dt = 1 / 120) {
  const steps = Math.round(seconds / dt)
  for (let i = 0; i < steps; i++) step(game, dt, idle)
}

/** how far a velocity turned between two samples, in radians */
function turnBetween(before, ship) {
  const after = Math.hypot(ship.vx, ship.vy, ship.vz)
  const beforeLength = Math.hypot(before.x, before.y, before.z)
  if (after < 1e-6 || beforeLength < 1e-6) return 0
  return Math.acos(Math.min(1, (before.x * ship.vx + before.y * ship.vy + before.z * ship.vz) / (beforeLength * after)))
}

test('the station\'s own orbit is a real circular orbit under the derived gravity', () => {
  // mu is read off the station's scripted orbit, so this is the whole anchor:
  // a ship matching the ISS's speed really is in orbit with it
  assert.ok(Math.abs(Math.sqrt(EARTH_MU / ISS_ORBIT) - ISS_ORBIT_RATE * ISS_ORBIT) < 1e-9)
  assert.ok(Math.abs(EARTH_SURFACE_G - 26) < 0.01, `Earth pulls ${EARTH_SURFACE_G} u/s^2 at its surface`)
  // and the smaller worlds pull as the real ones do, relative to Earth
  const surface = (body) => PLANET_MU[body] / PLANETS[body].spaceRadius ** 2
  assert.ok(Math.abs(surface(1) / surface(0) - 0.165) < 1e-9, 'the Moon is one sixth of Earth')
  assert.ok(Math.abs(surface(2) / surface(0) - 0.379) < 1e-9, 'Mars is 0.379 of Earth')
})

test('let go low over a world and the tug falls, exactly as gravity says it must', () => {
  const game = running()
  const radius = 3 * EARTH_RADIUS
  orbitAt(game, 0, radius, 0, { angle: awayFromMoon(game) })   // co-moving, no sideways speed
  run(game, 2.5)
  const state = relative(game, 0)
  assert.ok(state.radius < radius - 5, `the tug fell (${radius.toFixed(0)} -> ${state.radius.toFixed(0)})`)
  // vis-viva: everything the fall gained came from the drop
  const expected = Math.sqrt(2 * EARTH_MU * (1 / state.radius - 1 / radius))
  assert.ok(Math.abs(state.speed - expected) / expected < 0.03,
    `speed ${state.speed.toFixed(2)} against vis-viva ${expected.toFixed(2)}`)
})

test('a slow arrival is caught: letting go in a world\'s pull leaves you circling it', () => {
  const game = running()
  const circular = Math.sqrt(EARTH_MU / ISS_ORBIT)
  orbitAt(game, 0, ISS_ORBIT, circular * 0.7, { angle: awayFromMoon(game) })   // well short of orbital speed
  run(game, 6)
  const settled = relative(game, 0)
  run(game, 2)
  const state = relative(game, 0)
  assert.ok(Math.abs(state.speed - Math.sqrt(EARTH_MU / state.radius)) / state.speed < 0.02,
    `the tug rides a circular orbit (v ${state.speed.toFixed(2)} vs ${Math.sqrt(EARTH_MU / state.radius).toFixed(2)})`)
  assert.ok(Math.abs(state.radius - settled.radius) < 1.5,
    `and holds its altitude (${settled.radius.toFixed(1)} -> ${state.radius.toFixed(1)})`)
  const outward = (state.vx * state.dx + state.vy * state.dy + state.vz * state.dz) / state.radius
  assert.ok(Math.abs(outward) < 0.2, `no radial drift left (${outward.toFixed(2)})`)
})

test('a tug that matches the ISS rides around the Earth with it', () => {
  const game = running()
  const circular = Math.sqrt(EARTH_MU / ISS_ORBIT)
  const behind = Math.PI / 3
  orbitAt(game, 0, ISS_ORBIT, circular, { angle: game.issAngle - behind })
  const start = Math.hypot(game.ship.x - game.issPos.x, game.ship.y - game.issPos.y, game.ship.z - game.issPos.z)
  assert.ok(Math.abs(start - 2 * ISS_ORBIT * Math.sin(behind / 2)) < 1, `parked a third of a lap behind (${start.toFixed(1)})`)

  run(game, (2 * Math.PI) / ISS_ORBIT_RATE)     // one full lap of the station
  const now = Math.hypot(game.ship.x - game.issPos.x, game.ship.y - game.issPos.y, game.ship.z - game.issPos.z)
  assert.ok(Math.abs(now - start) < 0.15 * start,
    `still alongside after a lap (${start.toFixed(1)} -> ${now.toFixed(1)})`)
  const state = relative(game, 0)
  assert.ok(Math.abs(state.radius - ISS_ORBIT) / ISS_ORBIT < 0.02, 'same altitude as the station')
})

test('a fast flyby is bent by gravity and left to fly on', () => {
  const game = running()
  const radius = 4 * EARTH_RADIUS
  const tangential = 6 * Math.sqrt(EARTH_MU / radius)   // far too fast for the autopilot to touch
  orbitAt(game, 0, radius, tangential, { radial: -0.35 * tangential, angle: awayFromMoon(game) })
  const start = relative(game, 0)
  const before = { x: game.ship.vx, y: game.ship.vy, z: game.ship.vz }
  run(game, 1.5)
  const state = relative(game, 0)
  // vis-viva: the course bends, the energy does not change
  const expected = Math.sqrt(start.speed * start.speed + 2 * EARTH_MU * (1 / state.radius - 1 / radius))
  assert.ok(Math.abs(state.speed - expected) / expected < 0.02,
    `energy is conserved through the pass (${state.speed.toFixed(1)} vs ${expected.toFixed(1)})`)
  const turned = Math.acos(
    Math.min(1, (before.x * state.vx + before.y * state.vy + before.z * state.vz) / (Math.hypot(before.x, before.y, before.z) * state.speed)),
  )
  assert.ok(turned > 0.05, `the pass bends the course (${(turned * 180 / Math.PI).toFixed(1)} degrees)`)
})

test('deep space still parks the tug, and a well no longer does', () => {
  const parked = running(11)
  // straight out from the Sun past Earth's own sphere of influence: deep space only
  orbitAt(parked, 0, GRAVITY_SOI[0] + 40, 0, { angle: parked.earthAngle })
  parked.ship.vx += 200
  run(parked, 3)
  const easing = Math.hypot(parked.ship.vx, parked.ship.vy, parked.ship.vz)
  assert.ok(easing < 80, `outside every sphere of influence the autopilot is already braking (${easing.toFixed(1)} from 257)`)
  run(parked, 3)
  const stopped = Math.hypot(parked.ship.vx, parked.ship.vy, parked.ship.vz)
  assert.ok(stopped < 10, `and it parks the tug (${stopped.toFixed(2)})`)

  const coasting = running(11)
  orbitAt(coasting, 0, 2 * EARTH_RADIUS, 30)
  run(coasting, 2)
  const state = relative(coasting, 0)
  assert.ok(state.speed > 25, `inside the pull the tug keeps its speed and coasts (${state.speed.toFixed(2)})`)
})

test('a docked tug travels with the station, and undocking releases into its orbit', () => {
  const game = running(5)
  const ship = game.ship
  ship.x = game.dockPos.x
  ship.y = game.dockPos.y
  ship.z = game.dockPos.z
  ship.vx = ship.vy = ship.vz = 0
  ship.speed = 0
  assert.ok(dock(game), 'berthed at the hatch')

  run(game, 5)
  const hatch = Math.hypot(ship.x - game.dockPos.x, ship.y - game.dockPos.y, ship.z - game.dockPos.z)
  assert.ok(hatch < 0.001, 'still on the hatch while the station flies its orbit')
  const berthed = relative(game, 0)
  const stationSpeed = ISS_ORBIT_RATE * (ISS_ORBIT + ISS_DOCK_OFFSET)
  assert.ok(Math.abs(berthed.speed - stationSpeed) < 1,
    `and travelling with the station, not parked in the map (${berthed.speed.toFixed(1)} vs ${stationSpeed.toFixed(1)} u/s)`)

  assert.ok(undock(game), 'released')
  run(game, 10)
  const state = relative(game, 0)
  assert.ok(Math.abs(state.radius - ISS_ORBIT) / ISS_ORBIT < 0.15,
    `the release falls into the station's orbit, not out of it (r ${state.radius.toFixed(0)} vs ${ISS_ORBIT})`)
  const gap = Math.hypot(ship.x - game.issPos.x, ship.y - game.issPos.y, ship.z - game.issPos.z)
  assert.ok(gap < 80, `and drifts away from the station slowly (${gap.toFixed(1)} u)`)
})

test('gravity reaches exactly as far as the sphere of influence', () => {
  const inside = running(3)
  orbitAt(inside, 0, 700, 60, { angle: awayFromMoon(inside) })     // orbiting, far too fast to be trimmed
  const insideBefore = { x: inside.ship.vx, y: inside.ship.vy, z: inside.ship.vz }
  run(inside, 2)
  const insideTurn = turnBetween(insideBefore, inside.ship)

  const outside = running(3)
  orbitAt(outside, 0, GRAVITY_SOI[0] + 40, 60, { angle: outside.earthAngle })   // same speed, no field
  const outsideBefore = { x: outside.ship.vx, y: outside.ship.vy, z: outside.ship.vz }
  run(outside, 2)
  const outsideTurn = turnBetween(outsideBefore, outside.ship)

  assert.ok(insideTurn > 0.02, `the course bends inside the influence (${(insideTurn * 180 / Math.PI).toFixed(2)} degrees)`)
  assert.ok(outsideTurn < 0.005, `and holds straight outside it (${(outsideTurn * 180 / Math.PI).toFixed(2)} degrees)`)
})

test('gravity is frame-rate independent', () => {
  const slow = running(5)
  const fast = running(5)
  orbitAt(slow, 0, 3 * EARTH_RADIUS, 0)
  orbitAt(fast, 0, 3 * EARTH_RADIUS, 0)
  run(slow, 2, 1 / 60)
  run(fast, 2, 1 / 144)
  const a = relative(slow, 0)
  const b = relative(fast, 0)
  assert.ok(Math.abs(a.radius - b.radius) / a.radius < 0.02,
    `60 Hz and 144 Hz fall the same way (${a.radius.toFixed(1)} vs ${b.radius.toFixed(1)})`)
})

test('a landing approach is untouched by the autopilot', () => {
  const game = running(9)
  const low = EARTH_RADIUS + LAND_ZONE_HEIGHT * 0.5
  orbitAt(game, 0, low, 4)
  run(game, 2)
  const state = relative(game, 0)
  assert.ok(state.radius < low, 'low over a world the tug drops instead of being held up')
  assert.ok(state.speed < SHIP_SPEED, 'and never fights the player for speed down there')
})
