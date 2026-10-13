/**
 * Progressive LOD streaming — the pure decision core (plan §9).
 *
 * `sim/` never imports three.js and never touches the DOM, so this module owns
 * only the *decisions*: which distance tier every streamed object should be at,
 * in what order the missing tiers are worth building, and how much build time
 * the current frame may still spend. The renderer (`render/lod.ts`) owns the
 * meshes: it feeds distances in, runs its own chunked builders, and charges the
 * real milliseconds it spent back against the budget reported here.
 *
 * Tier 0 = glow impostor · tier 1 = low-poly stand-in · tier 2 = full detail.
 */

export type LodTier = 0 | 1 | 2

/** Distance thresholds for one streaming domain (the space map, a planet surface). */
export interface LodTuning {
  /** enter[k]: distance at or below which tier k should exist; index 0 is unused */
  enter: number[]
  /** exit[k]: distance at or above which tier k may be dropped again; index 0 unused */
  exit: number[]
  /** seconds of look-ahead: a body this far "into the future" counts as being here */
  leadTime: number
}

/** One streamed object, as the renderer sees it this frame. */
export interface LodTarget {
  id: number
  /** distance from the viewer to the object, world units */
  distance: number
  /** approach speed in units per second; negative when pulling away */
  closing: number
  /** game-logic floor: a tier that must exist whatever the distance says */
  minTier: LodTier
  /** estimated ms needed to build the next tier up */
  stepCostMs: number
  /** this object's distance thresholds (the space map and a surface tune differently) */
  tuning: LodTuning
}

/** A tier that is missing and therefore queued for incremental generation. */
export interface LodTask {
  id: number
  /** tier that is built right now */
  from: number
  /** tier the scheduler wants; the renderer climbs towards it one tier at a time */
  to: LodTier
  /** distance − closing × leadTime: lower means arriving sooner, so build sooner */
  urgency: number
  distance: number
  /** seconds until arrival at the current approach speed (Infinity when not closing) */
  eta: number
  /** true when the task exists because of a game-logic floor, not the distance */
  forced: boolean
  /** estimated ms still needed to finish the promotion */
  costMs: number
}

export interface LodState {
  /** tier that is actually built, per object id */
  tiers: number[]
  /** tier the scheduler wants after hysteresis and the game-logic floor */
  desired: number[]
  /** missing promotions, most urgent first */
  queue: LodTask[]
  /** ms this frame may still spend */
  budgetMs: number
  /** ms spent building this frame */
  spentMs: number
  /** frames processed, useful for debug output and tests */
  frame: number
}

export function createLodState(): LodState {
  return { tiers: [], desired: [], queue: [], budgetMs: 0, spentMs: 0, frame: 0 }
}

function clampTier(value: number): LodTier {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value >= 2 ? 2 : 1
}

function maxTier(a: LodTier, b: LodTier): LodTier {
  return a >= b ? a : b
}

/** Distance as it will be in `leadTime` seconds if the approach speed holds. */
export function approachDistance(distance: number, closing: number, leadTime: number): number {
  return closing > 0 ? distance - closing * leadTime : distance
}

/**
 * Distance-driven tier with hysteresis: tiers promote at `enter[k]` but only
 * demote at the wider `exit[k]`, so a ship sitting on a boundary cannot make
 * the builder thrash between two tiers. A single call can promote or drop more
 * than one tier when the distance jumps.
 */
export function tierForDistance(current: number, distance: number, tuning: LodTuning): LodTier {
  let tier = clampTier(current)
  while (tier < 2 && distance <= tuning.enter[tier + 1]) tier += 1
  while (tier > 0 && distance >= tuning.exit[tier]) tier -= 1
  return clampTier(tier)
}

function compareTasks(a: LodTask, b: LodTask): number {
  if (a.urgency !== b.urgency) return a.urgency - b.urgency
  // a tie means two worlds land together: build the deeper tier first
  if (a.to !== b.to) return b.to - a.to
  return a.id - b.id
}

/**
 * Start a frame: re-derive the wanted tier for every object, rebuild the
 * promotion queue most-urgent-first, and hand the renderer the work list.
 * Urgency is `distance − closing × leadTime`, so a world the janitor is
 * barrelling towards is queued ahead of one that is merely nearby - the
 * docking and landing targets are always warm before arrival.
 */
export function lodFrame(state: LodState, targets: LodTarget[], budgetMs: number): LodTask[] {
  state.frame += 1
  state.spentMs = 0
  state.budgetMs = Math.max(0, budgetMs)
  state.queue.length = 0
  for (const target of targets) {
    const tuning = target.tuning
    const built = state.tiers[target.id] ?? 0
    const lookahead = approachDistance(target.distance, target.closing, tuning.leadTime)
    const byDistance = tierForDistance(built, lookahead, tuning)
    const floor = clampTier(target.minTier)
    const wanted = maxTier(byDistance, floor)
    state.desired[target.id] = wanted
    if (wanted > built) {
      const closing = Math.max(0, target.closing)
      state.queue.push({
        id: target.id,
        from: built,
        to: wanted,
        urgency: target.distance - closing * tuning.leadTime,
        distance: target.distance,
        eta: closing > 1e-3 ? target.distance / closing : Infinity,
        forced: wanted > byDistance,
        costMs: Math.max(0, target.stepCostMs) * (wanted - built),
      })
    }
  }
  state.queue.sort(compareTasks)
  return state.queue
}

/** Tier that is built and safe to show, per object. */
export function lodTierOf(state: LodState, id: number): LodTier {
  return clampTier(state.tiers[id] ?? 0)
}

/** Tier the scheduler is aiming for, per object. */
export function lodDesiredOf(state: LodState, id: number): LodTier {
  return clampTier(state.desired[id] ?? 0)
}

/** ms of the frame budget still unspent. */
export function lodBudgetLeft(state: LodState): number {
  return Math.max(0, state.budgetMs - state.spentMs)
}

/** Charge real build time against this frame's budget. */
export function lodSpend(state: LodState, ms: number): void {
  if (Number.isFinite(ms) && ms > 0) state.spentMs += ms
}

/** Mark a tier as built: it stays available until it is dropped again. */
export function lodFinish(state: LodState, id: number, tier: LodTier): void {
  state.tiers[id] = clampTier(tier)
}

/**
 * Forget a tier — used when the geometry is thrown away (a new run, a new seed).
 * The object drops back to the stand-in until the scheduler rebuilds it.
 */
export function lodDrop(state: LodState, id: number, tier: LodTier = 0): void {
  state.tiers[id] = clampTier(tier)
  state.desired[id] = clampTier(tier)
}

/** Throw the whole schedule away (new run: new seed, new worlds). */
export function lodReset(state: LodState): void {
  state.tiers.length = 0
  state.desired.length = 0
  state.queue.length = 0
  state.spentMs = 0
  state.budgetMs = 0
}

/**
 * True when a queued tier is forced by game logic or lands inside `etaSeconds`.
 * The renderer widens its frame budget while that holds, so the world the
 * player is about to land on is finished rather than merely started.
 */
export function lodUrgentPending(state: LodState, etaSeconds: number): boolean {
  for (const task of state.queue) {
    if (task.forced || task.eta <= etaSeconds) return true
  }
  return false
}
