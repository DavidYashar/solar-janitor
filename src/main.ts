import {
  BEST_KEY, JUNK_COLORS, JUNK_POINTS, MUTE_KEY, OXYGEN_WARN, SAVE_KEY, SCANNER_RANGE, SPACE_SCALE,
} from './sim/config.ts'
import {
  bearingTo, buyItem, canDock, canLand, contextAction, contextLabel, createGame, hasRelic,
  hasUpgrade, latLonDistance, nearLander, objective, progressSummary, scannerPings, step, undock,
  wrapAngle,
} from './sim/game.ts'
import { quatRotate } from './sim/orient.ts'
import { landerSite, planetById } from './sim/planets.ts'
import { decodeSave, encodeSave, restoreSave, serializeSave } from './sim/save.ts'
import type { SaveData } from './sim/save.ts'
import type { Game, GameEvent, Input } from './sim/types.ts'
import { createWorld } from './render/scene.ts'
import { createHud } from './ui/hud.ts'
import type { CompassState, HazardHud, HudFrame, RadarBlip, RadarState } from './ui/hud.ts'
import { createInput } from './input.ts'
import { createAudio } from './audio.ts'
import { createPerf, formatPerf } from './perf.ts'

const STEP = 1 / 120
const CONJUGATE = { x: 0, y: 0, z: 0, w: 1 }
const OFFSET = { x: 0, y: 0, z: 0 }

const sceneRoot = document.getElementById('scene')
if (!sceneRoot) throw new Error('Missing #scene container')
const fadeEl = document.getElementById('fade')

const world = createWorld(sceneRoot)
const audio = createAudio()
const perf = createPerf()

const PICKUP_COLORS: Record<number, number> = {
  [JUNK_POINTS.scrap]: JUNK_COLORS.scrap,
  [JUNK_POINTS.tech]: JUNK_COLORS.tech,
  [JUNK_POINTS.hazardous]: JUNK_COLORS.hazardous,
  [JUNK_POINTS.relic]: JUNK_COLORS.relic,
}

// ------------------------------------------------------------- persistence

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage can be blocked; the run still works in memory */
  }
}

function loadBests(): Record<string, number> {
  const raw = readStorage(BEST_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const bests: Record<string, number> = {}
    for (const [mode, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) bests[mode] = value
    }
    return bests
  } catch {
    return {}
  }
}

function loadSave(): { data: SaveData; info: string } | null {
  const data = decodeSave(readStorage(SAVE_KEY))
  if (!data) return null
  const probe = restoreSave(data)
  if (!probe) return null
  const summary = progressSummary(probe)
  const where = probe.mode === 'surface'
    ? planetById(probe.planetId).name.toUpperCase()
    : probe.mode === 'docked' ? 'DOCKED AT THE ISS' : 'IN ORBIT'
  return {
    data,
    info: `${where} · ${summary.systemDelivered}/${summary.systemTotal} swept · ${probe.credits.toLocaleString()} cr`,
  }
}

function writeSave(): boolean {
  if (game.phase !== 'playing') return false
  writeStorage(SAVE_KEY, encodeSave(serializeSave(game)))
  return true
}

function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------- state

const bests = loadBests()
const MODE = 'career'
let best = bests[MODE] ?? 0
let game: Game = createGame()
let lastPhase = game.phase
let lastMode = game.mode
let accumulator = 0
let lastFrame = performance.now()
let shopOpen = false
let fadeOut = 0
let spaceHintUntil = 0
let saveAvailable = loadSave() !== null
let perfVisible = false
let perfShownAt = 0

function recordBest() {
  if (game.score <= best) return false
  best = game.score
  bests[MODE] = best
  writeStorage(BEST_KEY, JSON.stringify(bests))
  return true
}

function startRun(next: Game) {
  game = next
  game.phase = 'playing'
  lastPhase = 'playing'
  lastMode = game.mode
  accumulator = 0
  shopOpen = false
  fadeOut = 1
  hud.hideOverlay()
  hud.setMuted(audio.isMuted())
  audio.unlock()
  audio.play('ui')
  world.setReducedMotion(reducedMotion())
  world.setQuality(false)
  // dispatch flavour for the start of every shift (plan §6 story dressing)
  game.events.push({
    kind: 'hint',
    text: 'DISPATCH: ROUTE EARTH -> MOON -> MARS. DON\'T DIE.',
    amount: 0,
    place: 'surface',
    lat: game.player.lat,
    lon: game.player.lon,
    h: 0,
    x: 0,
    y: 0,
    z: 0,
  })
}

function newRun() {
  clearSave()
  saveAvailable = false
  startRun(createGame({ seed: Date.now() >>> 0 }))
}

function continueRun() {
  const loaded = loadSave()
  if (!loaded) {
    newRun()
    return
  }
  const restored = restoreSave(loaded.data)
  if (!restored) {
    newRun()
    return
  }
  startRun(restored)
}

function toMenu() {
  game = createGame()
  lastPhase = 'ready'
  lastMode = game.mode
  shopOpen = false
  fadeOut = 1
  saveAvailable = loadSave() !== null
  const loaded = loadSave()
  hud.showTitle(best, loaded ? loaded.info : null)
}

function togglePause() {
  if (game.phase === 'playing') {
    writeSave()
    game.phase = 'paused'
    lastPhase = 'paused'
    hud.showPause(game)
    audio.play('ui')
  } else if (game.phase === 'paused') {
    game.phase = 'playing'
    lastPhase = 'playing'
    hud.hideOverlay()
    audio.play('ui')
  }
}

function toggleMute() {
  const muted = !audio.isMuted()
  audio.setMuted(muted)
  hud.setMuted(muted)
  writeStorage(MUTE_KEY, muted ? '1' : '0')
}

function onContext() {
  audio.unlock()
  if (game.phase !== 'playing' || game.transition) return
  if (game.mode === 'docked') {
    if (shopOpen) {
      if (undock(game)) {
        shopOpen = false
        hud.hideOverlay()
      }
    } else {
      shopOpen = true
      hud.showShop(game)
      audio.play('ui')
    }
    return
  }
  contextAction(game)
}

function onConfirm() {
  audio.unlock()
  if (game.phase === 'ready') {
    if (saveAvailable) continueRun()
    else newRun()
  } else if (game.phase === 'finished') {
    newRun()
  }
}

const hud = createHud({
  start: newRun,
  continueRun,
  resume: togglePause,
  restart: newRun,
  quit: toMenu,
  togglePause,
  toggleMute,
  buy: (id: string) => {
    if (buyItem(game, id)) {
      audio.unlock()
      hud.showShop(game)
      writeSave()
    }
  },
  depart: () => {
    if (undock(game)) {
      shopOpen = false
      hud.hideOverlay()
      writeSave()
    }
  },
  closeShop: () => {
    shopOpen = false
    hud.hideOverlay()
    audio.play('ui')
  },
})

const input = createInput({
  context: onContext,
  confirm: onConfirm,
  togglePause,
  toggleMute,
  togglePerf: () => {
    perfVisible = !perfVisible
    if (!perfVisible) hud.setPerf(null)
  },
  boost: () => {
    if (game.phase === 'playing' && game.mode === 'space') audio.play('thrust', 0.6)
  },
})

function handleEvent(event: GameEvent) {
  hud.pushEvent(event)
  switch (event.kind) {
    case 'pickup':
      world.burst(event, PICKUP_COLORS[event.amount] ?? JUNK_COLORS.scrap, 9, 7)
      audio.play('pickup', 0.7)
      break
    case 'deposit':
      world.burst(event, 0xffd9a3, 16, 9)
      world.addShake(0.16)
      audio.play('deposit')
      break
    case 'deliver':
      world.burst(event, 0x9ff3d4, 34, 14)
      world.addShake(0.32)
      audio.play('deliver', Math.min(1.4, 0.75 + event.amount / 2000))
      writeSave()
      break
    case 'relic':
      world.burst(event, 0xffc24d, 46, 13)
      world.addShake(0.5)
      audio.play('relic')
      writeSave()
      break
    case 'buy':
      audio.play('buy')
      break
    case 'dock':
      world.burst(event, 0xcfe9ff, 18, 9)
      world.addShake(0.5)
      audio.play('dock')
      writeSave()
      break
    case 'undock':
      world.addShake(0.2)
      audio.play('undock')
      break
    case 'takeoff':
      world.burst(event, 0xffe3b0, 22, 12)
      world.addShake(0.45)
      audio.play('takeoff')
      break
    case 'land':
      world.burst(event, 0xd9c9a8, event.text ? 20 : 10, 8)
      if (event.text) {
        world.addShake(0.35)
        audio.play('land', 1)
        writeSave()
      } else {
        audio.play('land', 0.55)
      }
      break
    case 'meteor':
      world.burst(event, 0xff9a5c, 40, 15)
      world.addShake(0.8)
      audio.play('meteor', 0.8)
      break
    case 'storm':
      world.addShake(0.3)
      audio.play('storm', 0.8)
      break
    case 'hint':
      audio.play('hint')
      break
    case 'oxygen':
      world.addShake(0.25)
      audio.play('oxygen')
      break
    case 'rescue':
      world.burst(event, 0xb6ff9d, 44, 16)
      world.addShake(0.85)
      audio.play('rescue')
      break
    case 'block':
      audio.play('block')
      break
    case 'scrape':
      world.burst(event, 0xffb28a, 16, 9)
      world.addShake(0.5)
      audio.play('scrape')
      break
    case 'clean':
      world.burst(event, 0x9ff3d4, 60, 20)
      world.addShake(0.9)
      audio.play('clean')
      break
    case 'win':
      world.addShake(1)
      audio.play('win')
      break
    case 'lose':
      world.addShake(1.2)
      audio.play('lose')
      break
    default:
      break
  }
}

// ----------------------------------------------------------------- HUD data

function compassFor(state: Game): CompassState {
  const hidden: CompassState = { angle: 0, label: '', danger: false, visible: false }
  if (state.phase !== 'playing' || state.transition || state.mode === 'docked') return hidden

  if (state.mode === 'surface') {
    const site = landerSite(state.planetId)
    const distance = latLonDistance(state.player, site, state.planetId)
    return {
      // the rendered world is mirror-handed, so bearings are negated for the HUD
      angle: -wrapAngle(bearingTo(state.player, site) - state.player.facing),
      label: `LANDER ${distance.toFixed(0)}u`,
      danger: state.oxygen <= OXYGEN_WARN,
      visible: true,
    }
  }

  const target = objective(state)
  if (target.kind === 'none') return hidden
  OFFSET.x = (target.kind === 'iss' ? state.dockPos.x : state.planetPos[target.planetId].x) - state.ship.x
  OFFSET.y = (target.kind === 'iss' ? state.dockPos.y : state.planetPos[target.planetId].y) - state.ship.y
  OFFSET.z = (target.kind === 'iss' ? state.dockPos.z : state.planetPos[target.planetId].z) - state.ship.z
  CONJUGATE.x = -state.ship.q.x
  CONJUGATE.y = -state.ship.q.y
  CONJUGATE.z = -state.ship.q.z
  CONJUGATE.w = state.ship.q.w
  const local = quatRotate(CONJUGATE, OFFSET)
  const distance = Math.hypot(OFFSET.x, OFFSET.y, OFFSET.z)
  return {
    angle: -Math.atan2(local.x, local.z),
    label: `${target.label} ${distance.toFixed(0)}u`,
    danger: false,
    visible: true,
  }
}

function radarFor(state: Game): RadarState {
  const hidden: RadarState = { visible: false, range: 1, note: '', blips: [] }
  if (state.mode !== 'surface' || state.phase !== 'playing' || state.transition) return hidden
  const scanner = hasUpgrade(state, 'scanner')
  const eye = hasRelic(state, 'eye')
  if (!scanner && !eye) return hidden

  const pings = scannerPings(state)
  const blips: RadarBlip[] = pings.map(ping => ({
    bearing: ping.bearing,
    distance: ping.distance,
    kind: 'junk' as const,
    cls: ping.cls,
  }))
  const site = landerSite(state.planetId)
  blips.push({
    bearing: wrapAngle(bearingTo(state.player, site) - state.player.facing),
    distance: latLonDistance(state.player, site, state.planetId),
    kind: 'lander',
  })
  return {
    visible: true,
    range: eye ? 70 : SCANNER_RANGE,
    note: `${eye ? 'EYE IN THE SKY' : 'SCANNER'} · ${pings.length} PCS`,
    blips,
  }
}

function hazardFor(state: Game): HazardHud {
  if (state.mode !== 'surface' || state.phase !== 'playing' || state.transition) {
    return { text: '', level: '' }
  }
  const hazards = state.hazards
  if (hazards.meteorTelegraph >= 0) {
    const remaining = Math.max(0, hazards.meteorDelay - hazards.meteorTelegraph)
    return { text: `METEOR INBOUND ${remaining.toFixed(1)}s — KEEP MOVING`, level: 'danger' }
  }
  if (hazards.stormActive) {
    return { text: 'DUST STORM — OXYGEN DRAINING FAST', level: 'danger' }
  }
  if (Number.isFinite(hazards.stormTimer) && hazards.stormTimer <= 8) {
    return { text: `DUST STORM IN ${Math.max(0, hazards.stormTimer).toFixed(0)}s`, level: 'warn' }
  }
  return { text: '', level: '' }
}

function currentContext(): string {
  if (game.phase !== 'playing' || game.transition) return ''
  if (game.mode === 'docked') return shopOpen ? 'DEPART' : 'SHOP'
  return contextLabel(game)
}

function contextReady(): boolean {
  if (game.phase !== 'playing' || game.transition) return false
  if (game.mode === 'docked') return true
  if (game.mode === 'space') return canDock(game) || canLand(game)
  return nearLander(game)
}

function syncPhase() {
  if (game.phase === lastPhase) return
  lastPhase = game.phase
  if (game.phase === 'finished') {
    const isBest = recordBest()
    shopOpen = false
    clearSave()
    saveAvailable = false
    hud.showResults(game, best, isBest)
  } else if (game.phase === 'paused') {
    hud.showPause(game)
  } else if (game.phase === 'playing') {
    hud.hideOverlay()
  }
}

function syncMode() {
  if (game.mode === lastMode) return
  const previous = lastMode
  lastMode = game.mode
  fadeOut = game.mode === 'docked' ? 0.5 : 1
  if (game.mode === 'space') spaceHintUntil = performance.now() + 12000
  if (game.mode === 'docked') {
    // winning by delivering the last piece at the ISS must keep the results up
    if (game.phase === 'playing') {
      shopOpen = true
      hud.showShop(game)
    }
  } else if (previous === 'docked') {
    shopOpen = false
    if (game.phase === 'playing') hud.hideOverlay()
  }
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// -------------------------------------------------------------------- loop

function frame(now: number) {
  requestAnimationFrame(frame)
  const dt = Math.min(0.25, Math.max(0, (now - lastFrame) / 1000))
  lastFrame = now
  perf.sample(dt)
  const command: Input = input.read({ mode: game.mode, facing: game.player.facing })

  if (game.phase === 'playing') {
    accumulator += dt
    let steps = 0
    while (accumulator >= STEP && steps < 12) {
      step(game, STEP, command)
      accumulator -= STEP
      steps++
      if (game.phase !== 'playing') break
    }
    if (accumulator > 0.5) accumulator = 0
  }

  if (game.events.length > 0) {
    for (const event of game.events) handleEvent(event)
    game.events.length = 0
  }

  syncPhase()
  syncMode()

  const context = currentContext()
  const frameData: HudFrame = {
    game,
    context,
    compass: compassFor(game),
    radar: radarFor(game),
    hazard: hazardFor(game),
  }
  world.update(game, dt)
  hud.update(frameData)

  // debug overlay: refreshed a few times a second so that watching the numbers
  // costs far less than the thing it is measuring
  if (perfVisible && now - perfShownAt > 250) {
    perfShownAt = now
    const render = world.renderStats()
    hud.setPerf(formatPerf(perf.report(), [
      `draws ${render.calls}   tris ${(render.triangles / 1000).toFixed(0)}k   tex ${render.textures}   prog ${render.programs}`,
      `${render.drawingBuffer.width}x${render.drawingBuffer.height} @${render.pixelRatio.toFixed(2)}   ${render.quality}   webgl2 ${render.webgl2}`,
    ]))
  }
  const touch = input.isTouch()
  hud.setTouch(touch && game.phase !== 'ready')
  hud.setLookHint(game.mode === 'space' && game.phase === 'playing' && !touch && performance.now() < spaceHintUntil)
  input.setTouchLabels({
    hop: game.mode === 'surface' ? 'HOP' : 'BOOST',
    action: context,
    actionReady: contextReady(),
    roll: game.mode === 'space',
  })

  // transition fade: opaque across the mode switch, then a quick clear
  if (fadeEl) {
    if (game.transition) {
      const t = Math.min(1, game.transition.t / game.transition.duration)
      fadeEl.style.opacity = String(Math.pow(t, 1.5).toFixed(3))
    } else if (fadeOut > 0) {
      fadeOut = Math.max(0, fadeOut - dt / 0.55)
      fadeEl.style.opacity = String(fadeOut.toFixed(3))
    } else if (fadeEl.style.opacity !== '0') {
      fadeEl.style.opacity = '0'
    }
  }

  // ambient loops
  const playing = game.phase === 'playing'
  if (playing && game.mode === 'surface') {
    const carrying = game.junk.some(item => item.status === 'carried')
    audio.setLoop('vacuum', carrying ? 0.75 : 0.35)
    audio.setLoop('thruster', 0)
    audio.setLoop('wind', game.hazards.stormIntensity * (planetById(game.planetId).hazard === 'storm' ? 1 : 0))
  } else if (playing && game.mode === 'space') {
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', Math.max(0, game.ship.thrust) * (game.ship.boosting ? 1.3 : 0.65))
    audio.setLoop('wind', 0)
  } else {
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', 0)
    audio.setLoop('wind', 0)
  }
}

window.addEventListener('resize', () => world.resize())
window.addEventListener('orientationchange', () => setTimeout(() => world.resize(), 200))
window.addEventListener('pagehide', () => writeSave())
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.phase === 'playing') {
    writeSave()
    game.phase = 'paused'
    hud.showPause(game)
    audio.setLoop('vacuum', 0)
    audio.setLoop('thruster', 0)
    audio.setLoop('wind', 0)
  }
})

hud.setMuted(audio.isMuted())
world.setReducedMotion(reducedMotion())
{
  const loaded = loadSave()
  hud.showTitle(best, loaded ? loaded.info : null)
}

try {
  if (readStorage(MUTE_KEY) === '1') audio.setMuted(true)
} catch {
  /* ignore */
}

// dev-only handle so browser playtests can inspect and drive the run
if (import.meta.env.DEV) {
  ;(window as unknown as { __solar: unknown }).__solar = {
    get game() {
      return game
    },
    newRun,
    continueRun,
    toMenu,
    world,
    lodStats: () => world.lodStats(),
    perf: () => ({ frames: perf.report(), render: world.renderStats() }),
    perfReset: () => perf.reset(),
    perfOverlay: (on: boolean) => { perfVisible = on; if (!on) hud.setPerf(null) },
    hud,
    audio,
    contextAction: onContext,
    buy: (id: string) => buyItem(game, id),
    objective: () => objective(game),
    save: () => writeSave(),
    clearSave,
    hasSave: () => loadSave() !== null,
    serialize: () => serializeSave(game),
    restore: (data: SaveData) => {
      const restored = restoreSave(data)
      if (!restored) return false
      startRun(restored)
      return true
    },
    /** put the ship in orbit right above a planet (0 Earth, 1 Moon, 2 Mars) */
    teleportTo: (planetId: number, offset = 28 * SPACE_SCALE) => {
      const position = game.planetPos[planetId]
      game.mode = 'space'
      game.transition = null
      game.planetId = planetId
      game.ship.x = position.x + offset
      game.ship.y = position.y
      game.ship.z = position.z
      game.ship.vx = 0
      game.ship.vy = 0
      game.ship.vz = 0
      game.ship.speed = 0
      return true
    },
    dockNow: () => {
      game.mode = 'space'
      game.transition = null
      game.ship.x = game.dockPos.x
      game.ship.y = game.dockPos.y
      game.ship.z = game.dockPos.z
      game.ship.speed = 0
      return contextAction(game)
    },
    landNow: () => {
      const position = game.planetPos[game.planetId]
      game.mode = 'space'
      game.transition = null
      game.ship.x = position.x + 8 * SPACE_SCALE
      game.ship.y = position.y
      game.ship.z = position.z
      game.ship.speed = 0
      return contextAction(game)
    },
    giveCredits: (amount: number) => {
      game.credits += amount
      return game.credits
    },
  }
}

// Read-only diagnostics, available in the shipped build too: `__solarPerf.report()`
// in the console gives the same frame-time window and renderer counters the debug
// overlay shows — the way to check a real machine without a dev server.
;(window as unknown as { __solarPerf: unknown }).__solarPerf = {
  report: () => ({ frames: perf.report(), render: world.renderStats() }),
  reset: () => perf.reset(),
  overlay: (on: boolean) => {
    perfVisible = on
    if (!on) hud.setPerf(null)
  },
  lod: () => world.lodStats(),
}

requestAnimationFrame(frame)
