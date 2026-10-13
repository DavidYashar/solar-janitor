import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOD_FRAME_BUDGET_MS, LOD_URGENT_BUDGET_MS, LOD_SPACE_TUNING } from '../src/sim/config.ts'
import { createLodStreamer } from '../src/render/lod.ts'

/**
 * The streamer's *engine* runs headlessly: `render/lod.ts` imports three.js for
 * types only, so a fake scene graph is enough to drive the exact budget loop
 * that runs in the browser. Simulation behaviour lives in tests/lod.test.mjs.
 */

/** Pretend the frame clock, so slice costs are exact and the tests stay fast. */
const realPerformance = globalThis.performance
let clock = 0
let sliceCost = 1
globalThis.performance = { now: () => clock }

function fakeObject() {
  return {
    visible: false,
    parent: null,
    scale: { value: 1, setScalar(value) { this.value = value } },
    add(child) {
      child.parent = this
    },
  }
}

function fakeMaterial(opacity = 1) {
  return { opacity }
}

/** A generator that needs `slices` bounded slices and reports each one as cost. */
function fakeBuild(to, object, options = {}) {
  let left = options.slices ?? SLICES
  return {
    to,
    layer: { object, pop: options.pop, fade: options.fade },
    slice() {
      clock += sliceCost
      left -= 1
      return left <= 0
    },
    commit() {
      options.onCommit?.()
    },
  }
}

/** More slices than any single frame's budget can pay for, at 1 ms each. */
const SLICES = 12

function fakeSubject(id, root, options = {}) {
  const impostorObject = fakeObject()
  const impostorMaterial = fakeMaterial()
  const layers = new Map()
  return {
    id,
    tuning: LOD_SPACE_TUNING,
    root,
    impostor: { object: impostorObject, fade: [impostorMaterial] },
    state: { impostorObject, impostorMaterial, layers, built: [] },
    build(tier) {
      if (options.build) return options.build(tier)
      const object = fakeObject()
      const material = fakeMaterial(0.8)
      layers.set(tier, { object, material })
      this.state.built.push(tier)
      return fakeBuild(tier, object, { slices: options.slices ?? SLICES })
    },
    estimate: () => 1,
  }
}

function query(id, distance, minTier = 0, closing = 0) {
  return { id, distance, closing, minTier }
}

/** Run frames until `check` passes; returns how many frames that took. */
function pump(streamer, queries, check, max = 60, dt = 1 / 60) {
  let frames = 0
  while (frames < max) {
    clock = 0
    streamer.update(queries, dt)
    frames += 1
    if (check()) break
  }
  return frames
}

test.after(() => {
  globalThis.performance = realPerformance
})

test('a world starts as its impostor and refines as the janitor closes in', () => {
  const streamer = createLodStreamer()
  const root = fakeObject()
  const subject = fakeSubject(0, root)
  streamer.register(subject)
  assert.equal(subject.state.impostorObject.visible, true, 'the impostor is up from frame one')
  assert.equal(subject.state.impostorObject.parent, root)

  // far away: nothing to build
  clock = 0
  streamer.update([query(0, 2000)], 1 / 60)
  assert.equal(streamer.tierOf(0), 0)
  assert.equal(streamer.pending(), 0)
  assert.equal(streamer.lastSpend(), 0, 'an out-of-range world costs nothing')

  // inside the stand-in band: the low tier appears across frames, not in one go
  const frames = pump(streamer, [query(0, 500)], () => streamer.tierOf(0) >= 1)
  assert.ok(frames >= 2, `the stand-in took ${frames} frames of slices`)
  assert.equal(streamer.shownOf(0), 1)
  const low = subject.state.layers.get(1)
  assert.equal(low.object.visible, true, 'the new tier is on screen')
  assert.equal(low.object.parent, root)
  assert.ok(
    low.object.scale.value > 1 && low.object.scale.value <= 1.035,
    'it pops in a hair large, then settles',
  )

  // the tier below fades out instead of blinking off
  clock = 0
  streamer.update([query(0, 500)], 0.5)
  assert.equal(subject.state.impostorMaterial.opacity, 0, 'the impostor faded away')
  assert.equal(subject.state.impostorObject.visible, false)
  assert.equal(low.object.scale.value, 1, 'the reveal settled')

  // close enough for the detail tier
  pump(streamer, [query(0, 120)], () => streamer.tierOf(0) >= 2)
  assert.equal(streamer.tierOf(0), 2)
  assert.equal(subject.state.layers.get(2).object.visible, true)
  assert.equal(low.object.visible, false, 'the stand-in makes way once the detail is up')
})

test('flying away demotes the tier and the impostor comes back at full strength', () => {
  const streamer = createLodStreamer()
  const subject = fakeSubject(7, fakeObject())
  streamer.register(subject)
  pump(streamer, [query(7, 100)], () => streamer.tierOf(7) >= 2)
  assert.equal(streamer.tierOf(7), 2)
  clock = 0
  streamer.update([query(7, 100)], 0.6) // let the impostor fade fully out
  assert.equal(subject.state.impostorMaterial.opacity, 0)

  // way out past the exit band: the glow is what you see again
  clock = 0
  streamer.update([query(7, 5000)], 1 / 60)
  assert.equal(streamer.tierOf(7), 2, 'built geometry is kept, never re-generated')
  assert.equal(streamer.shownOf(7), 0, 'but the scheduler demotes what is on screen')
  assert.equal(streamer.pending(), 0)
  assert.equal(subject.state.impostorObject.visible, true)
  assert.equal(subject.state.impostorMaterial.opacity, 1, 'and it is fully opaque again')
  assert.equal(subject.state.layers.get(2).object.visible, false)
})

test('the frame budget spreads a long build over several frames', () => {
  const streamer = createLodStreamer()
  const subject = fakeSubject(3, fakeObject(), { slices: 40 })
  streamer.register(subject)
  let frames = 0
  while (streamer.tierOf(3) < 2 && frames < 200) {
    clock = 0
    streamer.update([query(3, 120, 2)], 1 / 60)
    const spent = streamer.lastSpend()
    assert.ok(
      spent <= LOD_URGENT_BUDGET_MS + sliceCost,
      `a frame spent ${spent}ms, never much past the budget`,
    )
    frames += 1
  }
  assert.ok(frames >= 4, `an 80-slice build took ${frames} frames, not one long stall`)
  clock = 0
  streamer.update([query(3, 120, 2)], 1 / 60)
  assert.equal(streamer.pending(), 0, 'the queue empties once the world is warm')
  assert.equal(streamer.lastSpend(), 0)
  assert.equal(streamer.tierOf(3), 2)
  assert.equal(streamer.shownOf(3), 2)
})

test('reduced motion skips the reveal and fade animation', () => {
  const streamer = createLodStreamer()
  const subject = fakeSubject(5, fakeObject())
  streamer.register(subject)
  streamer.setReducedMotion(true)
  pump(streamer, [query(5, 200)], () => streamer.tierOf(5) >= 2, 40, 1 / 60)
  assert.equal(streamer.tierOf(5), 2)
  clock = 0
  streamer.update([query(5, 200)], 1 / 60)
  assert.equal(subject.state.impostorMaterial.opacity, 0, 'the swap is instant, not animated')
  assert.equal(subject.state.layers.get(2).object.scale.value, 1, 'and nothing scales in')
})

test('unregister stops the work and takes the layers off screen', () => {
  const streamer = createLodStreamer()
  const subject = fakeSubject(9, fakeObject())
  streamer.register(subject)
  clock = 0
  streamer.update([query(9, 200)], 1 / 60)
  assert.equal(streamer.pending(), 1, 'the promotion is in flight')
  streamer.unregister(9)
  assert.equal(streamer.pending(), 0, 'a gone object leaves nothing queued')
  for (const layer of subject.state.layers.values()) {
    assert.equal(layer.object.visible, false)
  }
  assert.equal(subject.state.impostorObject.visible, false)
  // a stale query for a gone object is ignored rather than throwing
  clock = 0
  streamer.update([query(9, 200)], 1 / 60)
  assert.equal(streamer.pending(), 0)
  assert.equal(streamer.lastSpend(), 0)
})

test('registration is monotonic: a settled world costs nothing to keep', () => {
  const streamer = createLodStreamer()
  const subject = fakeSubject(4, fakeObject())
  streamer.register(subject)
  pump(streamer, [query(4, 90)], () => streamer.tierOf(4) >= 2)
  assert.equal(streamer.tierOf(4), 2)
  clock = 0
  for (let i = 0; i < 30; i++) streamer.update([query(4, 90)], 1 / 60)
  assert.equal(streamer.lastSpend(), 0, 'a warm world costs no build time at all')
  assert.ok(LOD_FRAME_BUDGET_MS < LOD_URGENT_BUDGET_MS, 'urgent frames get the wider budget')
})
