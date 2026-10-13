import type * as THREE from 'three'
import { LOD_FRAME_BUDGET_MS, LOD_URGENT_BUDGET_MS, LOD_URGENT_ETA } from '../sim/config.ts'
import {
  createLodState, lodBudgetLeft, lodDesiredOf, lodDrop, lodFinish, lodFrame, lodReset, lodSpend,
  lodTierOf, lodUrgentPending,
} from '../sim/lod.ts'
import type { LodTarget, LodTier, LodTuning } from '../sim/lod.ts'

/**
 * The visible half of the LOD streamer (plan §9). `sim/lod.ts` decides *what*
 * is worth building and how much of the frame budget is left; this module owns
 * the meshes: it mounts a freshly built tier, scales it into place, fades the
 * tier underneath away, and charges the real milliseconds every slice took.
 * Nothing here is built eagerly — a world starts as its impostor and refines as
 * the janitor closes in on it.
 */

/** seconds a freshly built tier takes to settle into place */
const REVEAL_TIME = 0.42
/** the tier below takes a little longer to disappear, so a swap never pops */
const FADE_TIME = 0.5
/** scale a new tier starts at before it settles to 1 */
const REVEAL_SCALE = 1.035

/** One visual tier of a streamed object. */
export interface LodLayer {
  object: THREE.Object3D
  /** scale the layer pops in from (1 = no pop: the ground must not move underfoot) */
  pop?: number
  /** materials dimmed away while this layer is replaced (must already be transparent) */
  fade?: THREE.Material[]
  /** filled in by the streamer: the opacities the layer fades from and returns to */
  base?: number[]
}

/** One bounded slice of a chunked build. */
export interface LodBuild {
  /** the tier this build promotes to (it may skip a tier that has no content) */
  to: LodTier
  /** the visual layer that is mounted when the build finishes */
  layer: LodLayer
  /** do one slice of work; true when the tier is ready to show */
  slice(): boolean
  /** run once, after the final slice reported done */
  commit(): void
}

/** A streamed object: an impostor, then whatever the builder climbs to. */
export interface LodSubject {
  id: number
  /** distance thresholds for this object's domain */
  tuning: LodTuning
  /** where the layers are mounted */
  root: THREE.Object3D
  /** tier 0: the cheap impostor, ready from the first frame */
  impostor: LodLayer
  /** create the builder that climbs towards `tier`, or null when there is nothing to build */
  build(tier: LodTier): LodBuild | null
  /** rough cost of climbing to `tier`, in ms */
  estimate(tier: LodTier): number
}

/** What the game knows about a streamed object this frame. */
export interface LodQuery {
  id: number
  /** distance from the viewer, world units */
  distance: number
  /** approach speed, units per second (negative when pulling away) */
  closing: number
  /** tier that must exist whatever the distance says */
  minTier: LodTier
}

export interface LodStreamer {
  register(subject: LodSubject): void
  /** forget one object (its geometry is disposed by the caller) */
  unregister(id: number): void
  /** plan, build within budget, animate the swaps */
  update(queries: LodQuery[], dt: number): void
  /** skip the reveal/fade animation when the player asked for less motion */
  setReducedMotion(value: boolean): void
  /** tier currently built */
  tierOf(id: number): LodTier
  /** tier on screen (never higher than the tier that is built) */
  shownOf(id: number): LodTier
  /** measured ms of building done in the last frame */
  lastSpend(): number
  /** promotions still queued; 0 means every wanted tier is warm */
  pending(): number
  /** throw every built tier away (a new run means a new seed) */
  reset(): void
}

/** A tier that costs nothing to finish: the content is already in hand. */
export function oneshotBuild(to: LodTier, layer: LodLayer): LodBuild {
  return { to, layer, slice: () => true, commit: () => {} }
}

/**
 * A tier generated across frames. The generator fills `layer.object` and yields
 * once per bounded slice; the streamer decides how many slices fit in a frame.
 */
export function generatorBuild(
  to: LodTier, layer: LodLayer, generator: Generator<void, void, void>,
): LodBuild {
  return {
    to,
    layer,
    slice() {
      return generator.next().done === true
    },
    commit: () => {},
  }
}

interface Slot {
  subject: LodSubject
  layers: (LodLayer | null)[]
  /** tier currently on show */
  shown: LodTier
  /** 0..1 reveal progress of the top layer */
  reveal: number
  /** the scale the top layer pops in from */
  pop: number
  /** layer on its way out, how far along and what its full opacities were */
  fading: LodLayer | null
  fadingBase: number[]
  fadeT: number
  /** the promotion that is part-built */
  build: LodBuild | null
  /** reusable target handed to the scheduler every frame */
  target: LodTarget
}

function clampTier(value: number): LodTier {
  if (value <= 0) return 0
  return value >= 2 ? 2 : 1
}

function minTier(a: LodTier, b: LodTier): LodTier {
  return a <= b ? a : b
}

function opacityOf(material: THREE.Material): number {
  const value = (material as { opacity?: number }).opacity
  return typeof value === 'number' ? value : 1
}

function setOpacity(material: THREE.Material, value: number) {
  ;(material as THREE.Material & { opacity: number }).opacity = value
}

export function createLodStreamer(): LodStreamer {
  const state = createLodState()
  const slots = new Map<number, Slot>()
  const targets: LodTarget[] = []
  let revealTime = REVEAL_TIME
  let fadeTime = FADE_TIME

  /** Remember the opacities a layer fades from, so it can come back later. */
  function baseline(layer: LodLayer): number[] {
    layer.base = layer.base ?? (layer.fade ? layer.fade.map(opacityOf) : [])
    return layer.base
  }

  /** Restore every material of a layer to the opacity it was born with. */
  function restore(layer: LodLayer) {
    const materials = layer.fade
    if (!materials) return
    const base = baseline(layer)
    for (let i = 0; i < materials.length; i++) setOpacity(materials[i], base[i] ?? 1)
  }

  /**
   * Show a freshly built tier: it scales in from a hair above its real size
   * while the tier underneath fades out, so a world refining in front of the
   * janitor reads as a settle rather than a pop.
   */
  function mount(slot: Slot, tier: LodTier, layer: LodLayer) {
    slot.layers[tier] = layer
    if (!layer.object.parent) slot.subject.root.add(layer.object)
    const previous = slot.layers[slot.shown]
    if (previous && previous !== layer) {
      if (previous.fade && previous.fade.length > 0) {
        slot.fading = previous
        slot.fadingBase = baseline(previous)
        slot.fadeT = 0
      } else {
        previous.object.visible = false
      }
    }
    layer.object.visible = true
    slot.pop = layer.pop ?? REVEAL_SCALE
    layer.object.scale.setScalar(slot.pop)
    slot.reveal = 0
    slot.shown = tier
  }

  /** Keep the visible tier in step with what is built and what is wanted. */
  function plan(slot: Slot) {
    const wanted = minTier(lodTierOf(state, slot.subject.id), lodDesiredOf(state, slot.subject.id))
    if (wanted === slot.shown) return
    const next = slot.layers[wanted]
    // a tier with no content keeps the tier above it on screen: never blank a world
    if (!next) return
    const current = slot.layers[slot.shown]
    if (current && current !== next) current.object.visible = false
    if (!next.object.parent) slot.subject.root.add(next.object)
    // a tier that faded out earlier comes back at full strength
    restore(next)
    next.object.visible = true
    next.object.scale.setScalar(1)
    slot.shown = wanted
    slot.reveal = 1
    if (slot.fading === current) slot.fading = null
  }

  function animate(slot: Slot, dt: number) {
    const layer = slot.layers[slot.shown]
    if (layer && slot.reveal < 1) {
      slot.reveal = Math.min(1, slot.reveal + dt / revealTime)
      const eased = 1 - Math.pow(1 - slot.reveal, 3)
      layer.object.scale.setScalar(slot.pop + (1 - slot.pop) * eased)
    }
    const fading = slot.fading
    if (!fading) return
    slot.fadeT = Math.min(1, slot.fadeT + dt / fadeTime)
    const opacity = 1 - slot.fadeT
    const materials = fading.fade ?? []
    for (let i = 0; i < materials.length; i++) {
      setOpacity(materials[i], (slot.fadingBase[i] ?? 1) * opacity)
    }
    if (slot.fadeT >= 1) {
      fading.object.visible = false
      slot.fading = null
    }
  }

  function reset() {
    lodReset(state)
    for (const slot of slots.values()) {
      for (const layer of slot.layers) {
        if (!layer) continue
        layer.object.visible = false
        layer.object.scale.setScalar(1)
        restore(layer)
      }
      slot.shown = 0
      slot.reveal = 1
      slot.fading = null
      slot.build = null
      const impostor = slot.layers[0]
      if (impostor) impostor.object.visible = true
    }
  }

  const streamer: LodStreamer = {
    register(subject) {
      const slot: Slot = {
        subject,
        layers: [subject.impostor, null, null],
        shown: 0,
        reveal: 1,
        pop: 1,
        fading: null,
        fadingBase: [],
        fadeT: 1,
        build: null,
        target: {
          id: subject.id, distance: 0, closing: 0, minTier: 0, stepCostMs: 0, tuning: subject.tuning,
        },
      }
      slots.set(subject.id, slot)
      subject.root.add(subject.impostor.object)
      subject.impostor.object.visible = true
    },

    unregister(id) {
      const slot = slots.get(id)
      if (!slot) return
      for (const layer of slot.layers) {
        if (layer) layer.object.visible = false
      }
      slots.delete(id)
      lodDrop(state, id)
    },

    update(queries, dt) {
      targets.length = 0
      for (const query of queries) {
        const slot = slots.get(query.id)
        if (!slot) continue
        const next = clampTier(lodTierOf(state, query.id) + 1)
        slot.target.distance = query.distance
        slot.target.closing = query.closing
        slot.target.minTier = query.minTier
        slot.target.stepCostMs = slot.subject.estimate(next)
        targets.push(slot.target)
      }

      // a tier the player needs right now — or lands on within seconds — widens the budget
      const budget = lodUrgentPending(state, LOD_URGENT_ETA) ? LOD_URGENT_BUDGET_MS : LOD_FRAME_BUDGET_MS
      const tasks = lodFrame(state, targets, budget)
      for (const task of tasks) {
        const slot = slots.get(task.id)
        if (!slot) continue
        const tier = clampTier(task.from + 1)
        if (!slot.build || slot.build.to !== tier) slot.build = slot.subject.build(tier)
        const build = slot.build
        if (!build) continue
        // bounded slices of work, charged against the frame budget as they run
        while (lodBudgetLeft(state) > 0) {
          const started = performance.now()
          const done = build.slice()
          lodSpend(state, performance.now() - started)
          if (!done) continue
          build.commit()
          lodFinish(state, task.id, build.to)
          mount(slot, build.to, build.layer)
          slot.build = null
          break
        }
      }

      for (const slot of slots.values()) {
        plan(slot)
        animate(slot, dt)
      }
    },

    tierOf(id) {
      return lodTierOf(state, id)
    },
    setReducedMotion(value) {
      // a hair of animation keeps the swap smooth; none of it is load-bearing
      revealTime = value ? 0.01 : REVEAL_TIME
      fadeTime = value ? 0.01 : FADE_TIME
    },
    shownOf(id) {
      return slots.get(id)?.shown ?? 0
    },
    lastSpend() {
      return state.spentMs
    },
    pending() {
      let count = 0
      for (const task of state.queue) {
        if (slots.has(task.id)) count += 1
      }
      return count
    },
    reset,
  }
  return streamer
}
