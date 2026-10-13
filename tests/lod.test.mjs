import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOD_FRAME_BUDGET_MS, LOD_SPACE_TUNING, LOD_SURFACE_TUNING, LOD_TERRAIN_SLICE, LOD_URGENT_BUDGET_MS, SPACE_SCALE,
} from '../src/sim/config.ts'
import {
  approachDistance, createLodState, lodBudgetLeft, lodDesiredOf, lodDrop, lodFrame, lodFinish,
  lodReset, lodSpend, lodTierOf, lodUrgentPending, tierForDistance,
} from '../src/sim/lod.ts'

/** A target with sane defaults so each test only states what it is about. */
function target(id, distance, closing = 0, minTier = 0, stepCostMs = 3, tuning = LOD_SPACE_TUNING) {
  return { id, distance, closing, minTier, stepCostMs, tuning }
}

/**
 * Stand-in for the renderer's budget loop: every job needs `slices` slices of
 * 1 ms, and the loop stops the moment the frame budget cannot pay for another.
 */
function runFrame(state, targets, budget, jobs, log = []) {
  const tasks = lodFrame(state, targets, budget)
  for (const task of tasks) {
    let left = jobs.get(task.id) ?? 0
    while (left > 0 && lodBudgetLeft(state) >= 1) {
      lodSpend(state, 1)
      left -= 1
      log.push(task.id)
    }
    jobs.set(task.id, left)
    if (left === 0) lodFinish(state, task.id, task.to)
  }
  return tasks
}

// ----------------------------------------------------------------- the tables

test('LOD tables promote tighter than they demote, so no tier can thrash', () => {
  for (const [name, tuning] of [['space', LOD_SPACE_TUNING], ['surface', LOD_SURFACE_TUNING]]) {
    assert.equal(tuning.enter.length, 3, `${name} enter table`)
    assert.equal(tuning.exit.length, 3, `${name} exit table`)
    for (const tier of [1, 2]) {
      assert.ok(tuning.enter[tier] < tuning.exit[tier], `${name} tier ${tier} has a hysteresis band`)
    }
    assert.ok(tuning.enter[2] < tuning.enter[1], `${name} detail is closer than the stand-in`)
    assert.ok(tuning.exit[2] < tuning.exit[1], `${name} detail drops before the stand-in`)
    assert.ok(tuning.leadTime > 0 && tuning.leadTime < 20, `${name} lead time is sane`)
  }
  assert.ok(LOD_FRAME_BUDGET_MS > 0 && LOD_FRAME_BUDGET_MS <= 6, 'frame budget leaves head-room')
  assert.ok(LOD_URGENT_BUDGET_MS >= LOD_FRAME_BUDGET_MS, 'urgent budget is never the smaller one')
  assert.ok(LOD_TERRAIN_SLICE > 0, 'terrain is built in slices')
})

// ------------------------------------------------------------ tier selection

test('distance tiers promote at enter and drop at exit', () => {
  const tuning = LOD_SPACE_TUNING
  assert.equal(tierForDistance(0, tuning.enter[1] + 1, tuning), 0)
  assert.equal(tierForDistance(0, tuning.enter[1], tuning), 1)
  assert.equal(tierForDistance(1, tuning.enter[2] + 1, tuning), 1)
  assert.equal(tierForDistance(1, tuning.enter[2], tuning), 2)
  assert.equal(tierForDistance(2, tuning.exit[2] - 1, tuning), 2)
  assert.equal(tierForDistance(2, tuning.exit[2], tuning), 1)
  assert.equal(tierForDistance(1, tuning.exit[1], tuning), 0)
  // a jump in distance resolves several tiers in a single decision
  assert.equal(tierForDistance(0, 10, tuning), 2)
  assert.equal(tierForDistance(2, 100000, tuning), 0)
  assert.equal(tierForDistance(-5, 10, tuning), 2, 'junk tier values clamp instead of exploding')
  assert.equal(tierForDistance(9, 10, tuning), 2, 'a too-high tier is clamped')
})

test('hysteresis holds a settled tier through a boundary wobble', () => {
  const tuning = LOD_SPACE_TUNING
  const boundary = (tuning.enter[1] + tuning.exit[1]) / 2
  assert.ok(boundary > tuning.enter[1] && boundary < tuning.exit[1], 'the test sits in the band')

  // settled one tier up: wobbling across the boundary never demotes
  let promoted = 1
  for (let i = 0; i < 600; i++) {
    promoted = tierForDistance(promoted, boundary + (i % 2 === 0 ? -4 : 4), tuning)
    assert.equal(promoted, 1)
  }
  // settled one tier down: the same wobble never promotes
  let idle = 0
  for (let i = 0; i < 600; i++) {
    idle = tierForDistance(idle, boundary + (i % 2 === 0 ? -4 : 4), tuning)
    assert.equal(idle, 0)
  }
  // only a real departure moves it
  assert.equal(tierForDistance(promoted, tuning.exit[1] + 0.01, tuning), 0)
  assert.equal(tierForDistance(idle, tuning.enter[1] - 0.01, tuning), 1)
})

test('approach distance looks ahead only while closing', () => {
  assert.equal(approachDistance(500, 50, 6), 200)
  assert.equal(approachDistance(500, -50, 6), 500, 'pulling away is not made worse')
  assert.equal(approachDistance(500, 0, 6), 500)
  assert.equal(approachDistance(500, 50, 0), 500)

  const state = createLodState()
  // 700 units out but boosting at 110 u/s is treated as a 40 unit approach
  const tasks = lodFrame(state, [target(2, 700 * SPACE_SCALE, 110 * SPACE_SCALE)], LOD_FRAME_BUDGET_MS)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].to, 2, 'the world refines before the janitor gets there')
  assert.ok(Math.abs(tasks[0].eta - 700 / 110) < 1e-6, 'eta is the real arrival time')
})

// -------------------------------------------------------------- the queue

test('the queue warms whatever the janitor is flying at first', () => {
  const state = createLodState()
  // drifting away from a nearby world vs. boosting at a far one
  const receding = target(0, 260 * SPACE_SCALE, -30 * SPACE_SCALE)
  const arriving = target(2, 700 * SPACE_SCALE, 110 * SPACE_SCALE)
  const tasks = lodFrame(state, [receding, arriving], LOD_FRAME_BUDGET_MS)
  assert.deepEqual(tasks.map(task => task.id), [2, 0], 'the approach target is queued first')
  assert.ok(tasks[0].urgency < tasks[1].urgency)
  assert.equal(tasks[1].eta, Infinity, 'a receding world never counts as arriving')

  // arrival inside the urgent window flips the wider frame budget on
  assert.equal(lodUrgentPending(state, 7), true, 'six and a bit seconds out is urgent soon enough')
  assert.equal(lodUrgentPending(state, 3), false, 'but not yet, three seconds out')
  const crawling = createLodState()
  lodFrame(crawling, [target(0, 900 * SPACE_SCALE, 10)], LOD_FRAME_BUDGET_MS)
  assert.equal(lodUrgentPending(crawling, 3), false, 'a far, slow approach is not urgent')
})

test('a game-logic floor forces a tier the distance rule would not ask for', () => {
  const state = createLodState()
  const tasks = lodFrame(state, [target(1, 5000 * SPACE_SCALE, 0, 2, 2)], LOD_FRAME_BUDGET_MS)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].from, 0)
  assert.equal(tasks[0].to, 2)
  assert.equal(tasks[0].forced, true)
  assert.equal(lodDesiredOf(state, 1), 2)
  assert.equal(lodTierOf(state, 1), 0, 'nothing is built until the budget loop runs')
  assert.equal(lodUrgentPending(state, 0), true, 'a forced tier is urgent by definition')

  // once the first tier lands the object stays in the queue for the next climb
  lodFinish(state, 1, 1)
  const next = lodFrame(state, [target(1, 5000 * SPACE_SCALE, 0, 2, 2)], LOD_FRAME_BUDGET_MS)
  assert.equal(next.length, 1)
  assert.equal(next[0].from, 1)
  assert.equal(next[0].to, 2)

  // the floor disappears: the scheduler goes back to wanting nothing
  lodFrame(state, [target(1, 5000 * SPACE_SCALE, 0, 0, 2)], LOD_FRAME_BUDGET_MS)
  assert.equal(lodDesiredOf(state, 1), 0)
})

// ------------------------------------------------------------- the budget

test('the frame budget cuts the build list mid-way and the rest resumes next frame', () => {
  const state = createLodState()
  // all three sit in the stand-in band, so each promotion is a single tier
  const targets = [target(0, 400 * SPACE_SCALE, 0), target(1, 500 * SPACE_SCALE, 0), target(2, 600 * SPACE_SCALE, 0)]
  const jobs = new Map([[0, 2], [1, 2], [2, 2]])
  const budget = 2.5
  const log = []

  runFrame(state, targets, budget, jobs, log)
  assert.deepEqual(log, [0, 0], 'only the first task got slices inside the budget')
  assert.ok(state.spentMs <= budget, 'never overspends the frame')
  assert.equal(lodTierOf(state, 0), 1, 'the finished promotion is remembered')
  assert.equal(lodTierOf(state, 1), 0, 'the starved one is still at the stand-in')
  const replan = lodFrame(state, targets, budget)
  assert.deepEqual(replan.map(task => task.id), [1, 2], 'the queue keeps its order')

  runFrame(state, targets, budget, jobs, log)
  assert.deepEqual(log.slice(2), [1, 1], 'the next frame picks up the same list')
  assert.equal(lodTierOf(state, 1), 1)
  assert.equal(lodTierOf(state, 2), 0)

  runFrame(state, targets, budget, jobs, log)
  assert.deepEqual(log.slice(4), [2, 2], 'and it finishes the last one')
  assert.equal(lodTierOf(state, 2), 1)
  assert.equal(lodBudgetLeft(state), 0.5, 'the leftover budget is reported honestly')
  const settled = lodFrame(state, targets, budget)
  assert.deepEqual(settled, [], 'an empty plan means the worlds are warm')
  assert.equal(lodBudgetLeft(state), budget, 'a fresh frame gets the whole budget back')

  // every task climbed exactly one tier: flying closer queues the next climb
  const closer = [target(0, 150 * SPACE_SCALE, 0), target(1, 160 * SPACE_SCALE, 0), target(2, 170 * SPACE_SCALE, 0)]
  const second = lodFrame(state, closer, budget)
  assert.deepEqual(second.map(task => [task.id, task.from, task.to]), [[0, 1, 2], [1, 1, 2], [2, 1, 2]])
})

test('build order is identical every time the same world is streamed', () => {
  const sequence = () => {
    const state = createLodState()
    const jobs = new Map([[0, 3], [1, 3], [2, 3]])
    const log = []
    for (let frame = 0; frame < 12; frame++) {
      // a world flying in: closing fast on 2, drifting past 0, parked near 1
      const targets = [
        target(0, (300 + frame * 12) * SPACE_SCALE, -12 * SPACE_SCALE),
        target(1, (240 - frame * 2) * SPACE_SCALE, 2 * SPACE_SCALE),
        target(2, (900 - frame * 55) * SPACE_SCALE, 55 * SPACE_SCALE),
      ]
      runFrame(state, targets, LOD_FRAME_BUDGET_MS, jobs, log)
    }
    return { log, tiers: [0, 1, 2].map(id => lodTierOf(state, id)) }
  }
  assert.deepEqual(sequence(), sequence())
  const { tiers } = sequence()
  assert.ok(tiers.every(tier => tier >= 1), 'every world ends up built')
})

// --------------------------------------------------------- dropping tiers

test('a new run drops everything and the schedule rebuilds from the glow', () => {
  const state = createLodState()
  lodFrame(state, [target(0, 100 * SPACE_SCALE), target(1, 200 * SPACE_SCALE)], LOD_FRAME_BUDGET_MS)
  lodFinish(state, 0, 2)
  lodFinish(state, 1, 2)
  assert.equal(lodTierOf(state, 0), 2)

  lodDrop(state, 1)
  assert.equal(lodTierOf(state, 1), 0)
  const requeued = lodFrame(state, [target(1, 200 * SPACE_SCALE)], LOD_FRAME_BUDGET_MS)
  assert.equal(requeued.length, 1)
  assert.equal(requeued[0].to, 2, 'the distance rule asks for the detail tier again')

  lodReset(state)
  assert.equal(state.queue.length, 0)
  assert.equal(state.frame, 2, 'the frame counter is not part of the schedule')
  assert.deepEqual(state.tiers, [])
  assert.equal(lodTierOf(state, 0), 0, 'a forgotten id reports the impostor tier')
})

// ------------------------------------------------------- end-to-end warm-up

test('a planet surface is fully built before the lander gets anywhere near it', () => {
  const state = createLodState()
  const planetId = 2
  const budget = LOD_FRAME_BUDGET_MS
  const frameDt = 1 / 60
  const buildSlices = 10 // 10 ms of terrain + props, spread over slices
  const jobs = new Map([[planetId, buildSlices]])
  let ship = 1500
  let warmAt = -1
  let arrived = false

  for (let frame = 0; frame < 60 * 30 && !arrived; frame++) {
    // the janitor boosts straight at Mars, slowing down inside the landing zone
    const speed = ship > 40 ? 110 : 30
    const closing = speed
    ship = Math.max(0, ship - speed * frameDt)
    const targets = [target(planetId, ship, closing, ship < 60 ? 2 : 0, 1, LOD_SURFACE_TUNING)]
    runFrame(state, targets, budget, jobs)
    if (lodTierOf(state, planetId) === 2 && warmAt < 0) {
      if (jobs.get(planetId) === 0) warmAt = ship
    }
    if (ship <= 40) arrived = true
  }

  assert.ok(arrived, 'the ship got there')
  assert.equal(lodTierOf(state, planetId), 2, 'the surface is warm on arrival')
  assert.ok(warmAt > 200, `the build finished with room to spare (finished at ${warmAt.toFixed(0)} u)`)
})
